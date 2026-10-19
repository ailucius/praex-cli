import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { createServer } from "http"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import open from "open"
import { OAUTH_DUMMY_KEY } from "../auth"

// Praex Cloud — the hosted tier (praex.ai gateway + velox247 fleet).
// Auth is a Firebase (GCP Identity Platform) ID token, not an API key. Sign-in is the
// loopback flow: `praex auth login` starts a listener on 127.0.0.1, opens
// praex.ai/cli-auth?port=…&state=… in the browser, the page signs the user in with
// Google and redirects back to the listener with the refresh token. A paste-code
// method remains for SSH/headless boxes. ID tokens live 1h, so the credential is
// refreshed inside a custom fetch — never stored in apiKey (it's snapshotted into
// the SDK cache key at load).
const FIREBASE_API_KEY = "AIzaSyBa0F9hDxnYMVObjeleNm_Sxh85UDesaQE" // public web key, not a secret
const SIGNIN_URL = "https://praex.ai/cli-auth"
const REFRESH_SKEW_MS = 60_000
// The page redirects to 127.0.0.1 literally (not "localhost") so a v6-first resolver
// can't send the browser to ::1 while the listener sits on v4.
const CALLBACK_PORT = 1456

type TokenResponse = {
  id_token: string
  refresh_token: string
  expires_in?: string | number
}

export async function exchangeRefreshToken(refreshToken: string): Promise<TokenResponse | undefined> {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  })
  if (!res.ok) return undefined
  return (await res.json()) as TokenResponse
}

export function expiresAt(tokens: TokenResponse) {
  return Date.now() + Number(tokens.expires_in ?? 3600) * 1000
}

const RESULT_PAGE = (body: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Praex</title><style>
  body{background:#0a0a0c;color:#e8e8ec;font:16px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;
    min-height:100vh;margin:0;display:grid;place-items:center}
  main{text-align:center;padding:24px}
  .mark{width:52px;height:52px;border-radius:14px;background:#1b1b22;border:1px solid #26262e;
    display:grid;place-items:center;font-size:26px;margin:0 auto 18px}
  h1{font-size:22px;letter-spacing:-0.02em;margin:0 0 6px}
  p{color:#8b8b96;margin:0}
</style></head><body><main><div class="mark">~</div>${body}</main></body></html>`

const HTML_SUCCESS = RESULT_PAGE(`<h1>Signed in</h1><p>You can close this tab and return to the terminal.</p>`)
const HTML_ERROR = (msg: string) => RESULT_PAGE(`<h1>Sign-in failed</h1><p>${msg}</p>`)

interface PendingSignIn {
  state: string
  resolve: (tokens: TokenResponse) => void
  reject: (error: Error) => void
}

// Sign-in can take a while on a fresh machine (password, 2FA, consent screens).
// The window must comfortably outlast all of that, or a perfectly good callback
// arrives after the state was wiped and reads as "stale".
const SIGNIN_TIMEOUT_MS = 15 * 60 * 1000

let callbackServer: ReturnType<typeof createServer> | undefined
let callbackPort: number | undefined
// Keyed by state so overlapping sign-ins (first-run child plus a manual retry)
// each keep their own slot instead of silently invalidating each other.
const pendingSignIns = new Map<string, PendingSignIn>()
// Completed states render the same result page again on reload/prefetch instead
// of a scary stale error after a successful sign-in.
const finishedSignIns = new Map<string, Promise<boolean>>()

const STALE_MESSAGE =
  "This sign-in link has expired. Run <code>praex login</code> in the terminal again, and finish in the newest browser tab it opens."

async function startCallbackServer(): Promise<number> {
  if (callbackServer && callbackPort) return callbackPort

  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${callbackPort}`)
    if (url.pathname !== "/auth/callback") {
      res.writeHead(404)
      res.end("Not found")
      return
    }

    const state = url.searchParams.get("state")
    const code = url.searchParams.get("code")

    const finished = state ? finishedSignIns.get(state) : undefined
    if (finished) {
      finished.then((ok) => {
        res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" })
        res.end(ok ? HTML_SUCCESS : HTML_ERROR("Could not verify the sign-in. Try again."))
      })
      return
    }

    const pending = state ? pendingSignIns.get(state) : undefined
    if (!pending) {
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end(HTML_ERROR(STALE_MESSAGE))
      return
    }
    if (!code) {
      pendingSignIns.delete(state!)
      res.writeHead(400, { "Content-Type": "text/html" })
      res.end(HTML_ERROR("The browser sent no credential back. Try again."))
      pending.reject(new Error("Missing connect code in callback"))
      return
    }

    pendingSignIns.delete(state!)

    // Verify the refresh token works before telling either side it succeeded.
    const outcome = exchangeRefreshToken(code)
      .then((tokens) => {
        if (!tokens) throw new Error("Token exchange failed")
        pending.resolve(tokens)
        return true
      })
      .catch((err) => {
        pending.reject(err instanceof Error ? err : new Error(String(err)))
        return false
      })
    finishedSignIns.set(state!, outcome)

    outcome.then((ok) => {
      res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html" })
      res.end(ok ? HTML_SUCCESS : HTML_ERROR("Could not verify the sign-in. Try again."))
    })
  })

  const listenOn = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      server.once("error", onError)
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError)
        const address = server.address()
        resolve(typeof address === "object" && address ? address.port : port)
      })
    })

  // Prefer the stable port; fall back to an ephemeral one if something else
  // holds it (another praex login, an unrelated app). The page redirects to
  // whatever port it was given, so any port works.
  callbackPort = await listenOn(CALLBACK_PORT).catch(() => listenOn(0))
  callbackServer = server
  return callbackPort
}

function stopCallbackServer() {
  callbackServer?.close(() => {})
  callbackServer = undefined
  callbackPort = undefined
}

function waitForCallback(state: string): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingSignIns.delete(state)) reject(new Error("Sign-in timed out"))
    }, SIGNIN_TIMEOUT_MS)
    pendingSignIns.set(state, {
      state,
      resolve: (tokens) => {
        clearTimeout(timeout)
        resolve(tokens)
      },
      reject: (error) => {
        clearTimeout(timeout)
        reject(error)
      },
    })
  })
}

// ---------- hosted lineup: the gateway is the source of truth ----------
// The hosted tier ships in the binary: every install gets the Praex provider without any
// config file. 09-06: a user-defined praex-cloud block used to REPLACE the shipped provider
// wholesale, so a machine carrying an old block silently kept showing a retired model while a
// clean install showed the current one. The model list is therefore never taken from config
// any more: it comes from the gateway's public /v1/models (id, name, plan, limit), is cached
// on disk so offline starts still work, and falls back to the baked-in list as a last resort.
// A user block may still override the endpoint (options.baseURL, e.g. a staging gateway) and
// the display name — nothing else. Retiring or adding a model is now a gateway deploy only.
const GATEWAY_BASE_URL = "https://praex-gateway-384599766402.us-central1.run.app/v1"
const TIER_LIMITS = { context: 32768, output: 8192 }
export type HostedModel = { name: string; plan?: string; limit: { context: number; output: number } }
export type HostedLineup = Record<string, HostedModel>
// Offline / first-run fallback only; the live gateway list always wins. Mirrors the gateway
// lineup as of 2026-10-19: Velox II (free), Faber II (Pro, on demand), Lucia II (Max).
export const BAKED_LINEUP: HostedLineup = {
  "velox-ii-baked": { name: "Velox II", plan: "free", limit: { ...TIER_LIMITS } },
  "faber-ii": { name: "Faber II · Pro", plan: "pro", limit: { ...TIER_LIMITS } }, // on demand, paying Pro only
  "lucia-ii": { name: "Lucia II · Max", plan: "max", limit: { ...TIER_LIMITS } },
}
const LINEUP_TIMEOUT_MS = 1500 // first launch with no cache blocks at most this long
const LINEUP_TTL_MS = 60 * 60 * 1000 // cache is served immediately; older than this = refresh in the background

export function parseLineup(body: unknown): HostedLineup | undefined {
  const data = (body as any)?.data
  if (!Array.isArray(data)) return undefined
  const out: HostedLineup = {}
  for (const m of data) {
    if (!m || typeof m.id !== "string" || !m.id) continue
    const context = Number(m.limit?.context)
    const output = Number(m.limit?.output)
    out[m.id] = {
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      ...(typeof m.plan === "string" && m.plan ? { plan: m.plan } : {}),
      limit: {
        context: Number.isFinite(context) && context > 0 ? context : TIER_LIMITS.context,
        output: Number.isFinite(output) && output > 0 ? output : TIER_LIMITS.output,
      },
    }
  }
  return Object.keys(out).length ? out : undefined
}

export async function fetchLineup(baseURL: string, timeoutMs = LINEUP_TIMEOUT_MS): Promise<HostedLineup | undefined> {
  try {
    const res = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    return parseLineup(await res.json())
  } catch {
    return undefined
  }
}

type LineupCache = { baseURL: string; fetchedAt: number; models: HostedLineup }
async function readCache(file: string): Promise<LineupCache | undefined> {
  try {
    const c = JSON.parse(await fs.readFile(file, "utf8"))
    return c && typeof c.baseURL === "string" && c.models && typeof c.models === "object" ? c : undefined
  } catch {
    return undefined
  }
}
async function writeCache(file: string, c: LineupCache) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify(c))
  } catch {}
}

// cache (any age, same endpoint) → served at once, refreshed in the background when stale;
// no cache → one bounded fetch; nothing reachable → baked list. Never throws.
export async function hostedLineup(
  baseURL: string,
  opts: { cacheFile?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<HostedLineup> {
  const file = opts.cacheFile ?? path.join(Global.Path.cache, "praex-cloud-models.json")
  const now = opts.now ?? Date.now
  const cached = await readCache(file)
  if (cached && cached.baseURL === baseURL) {
    if (now() - cached.fetchedAt >= LINEUP_TTL_MS)
      void fetchLineup(baseURL, opts.timeoutMs).then((m) => m && writeCache(file, { baseURL, fetchedAt: now(), models: m }))
    return cached.models
  }
  const live = await fetchLineup(baseURL, opts.timeoutMs)
  if (live) {
    await writeCache(file, { baseURL, fetchedAt: now(), models: live })
    return live
  }
  return BAKED_LINEUP
}

export function hostedBaseURL(user: Record<string, any> | undefined): string {
  const u = user?.options?.baseURL
  return typeof u === "string" && u ? u : GATEWAY_BASE_URL
}

// The provider block the CLI actually uses: the user's endpoint/name survive, the model list
// is always the lineup (so a stale user block can never resurrect a retired model).
/** The free tier's id: the entry with plan "free", else a display name ending in "· free", else the first entry. */
export function freeModelID(lineup: HostedLineup) {
  const ids = Object.keys(lineup)
  return (
    ids.find((id) => lineup[id].plan === "free") ?? ids.find((id) => /·\s*free$/i.test(lineup[id].name)) ?? ids[0]
  )
}

// The gateway may name a tier plainly ("Velox II") and carry its plan separately. The picker labels
// and orders tiers by a "· <plan>" suffix (tierRank in tui dialog-model), so add one when it is missing.
const PLAN_LABEL: Record<string, string> = { free: "Free", pro: "Pro", max: "Max" }
function displayName(m: HostedModel) {
  const label = m.plan ? PLAN_LABEL[m.plan] : undefined
  return label && !m.name.includes("·") ? `${m.name} · ${label}` : m.name
}

export function hostedProvider(user: Record<string, any> | undefined, lineup: HostedLineup) {
  const u = user ?? {}
  const free = freeModelID(lineup)
  return {
    ...u,
    npm: "@ai-sdk/openai-compatible",
    name: typeof u.name === "string" && u.name ? u.name : "Praex",
    options: { ...(u.options ?? {}), baseURL: hostedBaseURL(user) },
    // free tier first, for any client that keeps the provider's model order
    models: Object.fromEntries(
      Object.entries(lineup)
        .sort(([a], [b]) => Number(b === free) - Number(a === free))
        .map(([id, m]) => [id, { name: displayName(m), limit: { ...m.limit } }]),
    ),
  }
}

export async function PraexCloudAuthPlugin(input: PluginInput): Promise<Hooks> {
  let lineup: HostedLineup = BAKED_LINEUP
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const user = cfg.provider["praex-cloud"] as Record<string, any> | undefined
      lineup = await hostedLineup(hostedBaseURL(user))
      cfg.provider["praex-cloud"] = hostedProvider(user, lineup) as any
      // Praex is the default even when other providers are configured (a GEMINI_API_KEY in the
      // shell, say); a model the user set themselves always wins.
      cfg.model ??= `praex-cloud/${freeModelID(lineup)}`
    },
    // Session titles and other small-model work run on the free tier, never on a paid one.
    "experimental.provider.small_model": async (incoming, output) => {
      if (incoming.provider.id !== "praex-cloud") return
      output.model ??= incoming.provider.models[freeModelID(lineup)]
    },
    auth: {
      provider: "praex-cloud",
      methods: [
        {
          type: "oauth",
          label: "Praex account · sign in with Google (browser)",
          async authorize() {
            const port = await startCallbackServer()
            const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url")
            const url = `${SIGNIN_URL}?port=${port}&state=${state}`
            const tokensPromise = waitForCallback(state)
            open(url).catch(() => {})
            return {
              url,
              instructions:
                "Sign in with Google in the browser window that opened. Praex picks it up automatically.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await tokensPromise
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.id_token,
                    expires: expiresAt(tokens),
                  }
                } catch {
                  return { type: "failed" as const }
                } finally {
                  stopCallbackServer()
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "Connect code · paste from praex.ai (SSH / headless)",
          async authorize() {
            return {
              url: SIGNIN_URL,
              instructions: "Sign in with Google in any browser, then paste the connect code shown on the page.",
              method: "code" as const,
              callback: async (code: string) => {
                const tokens = await exchangeRefreshToken(code.trim())
                if (!tokens) return { type: "failed" as const }
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.id_token,
                  expires: expiresAt(tokens),
                }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        let refreshPromise: Promise<string> | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          // read by the desktop/web app to know a Praex account is connected (options reach the client)
          signedIn: true,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const headers = new Headers(init?.headers)
            headers.delete("authorization")

            const current = await getAuth()
            if (current.type !== "oauth") return fetch(requestInput, init)

            let access = current.access
            if (!access || current.expires < Date.now() + REFRESH_SKEW_MS) {
              if (!refreshPromise) {
                refreshPromise = exchangeRefreshToken(current.refresh)
                  .then(async (tokens) => {
                    if (!tokens)
                      throw new Error("Praex sign-in expired. Sign in again.")
                    await input.client.auth.set({
                      path: { id: "praex-cloud" },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.id_token,
                        expires: expiresAt(tokens),
                      },
                    })
                    return tokens.id_token
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              access = await refreshPromise
            }

            headers.set("authorization", `Bearer ${access}`)
            return fetch(requestInput, { ...init, headers })
          },
        }
      },
    },
  }
}
