// Remote Control (/rc): wiring between the TUI worker and the tunnel. Off until the user
// runs /rc; /rc again (or quitting) turns it off. Needs a Praex account (praex login).

import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Auth } from "@/auth"
import { exchangeRefreshToken, expiresAt } from "@/plugin/praex-cloud"
import { grantTtlFromEnv, RemoteTunnel, SignedOutError, type Credential, type RemoteStatus } from "./tunnel"
import { fakePhoneVerifier, firebasePhoneVerifier, uidOf } from "./verify"
import { base64Encode } from "@opencode-ai/core/util/encode"

export { SignedOutError, type RemoteStatus } from "./tunnel"

export const DEFAULT_RELAY_URL = "https://praex-relay-384599766402.us-central1.run.app"
export const REMOTE_LINK = "praex.ai/rc"
const REFRESH_BEFORE_MS = 10 * 60_000 // the relay closes a tunnel whose token lapsed; stay well ahead

export function relayConfig(env: Record<string, string | undefined> = process.env) {
  const url = (env.PRAEX_RELAY_URL || DEFAULT_RELAY_URL).replace(/\/+$/, "")
  const u = new URL(url)
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]"
  if (u.protocol !== "https:" && !loopback) throw new Error("The Remote Control relay address must use https.")
  // Fake test tokens only ever work against a relay on this machine.
  return { url, fake: env.PRAEX_RC_FAKE_AUTH === "1" && loopback }
}

const readAuth = () =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      return yield* auth.get("praex-cloud")
    }),
  )

const writeAuth = (info: { refresh: string; access: string; expires: number }) =>
  AppRuntime.runPromise(
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("praex-cloud", { type: "oauth", ...info })
    }),
  )

/** The signed-in Praex user's Firebase ID token, refreshed when it is close to expiry. */
export async function praexCredential(opts: { force?: boolean; fake?: boolean } = {}): Promise<Credential> {
  const info = await readAuth().catch(() => undefined)
  if (!info || info.type !== "oauth" || !info.refresh) throw new SignedOutError()
  let token = info.access
  let exp = info.expires
  if (!opts.fake && (opts.force || !token || exp < Date.now() + REFRESH_BEFORE_MS)) {
    let tokens: Awaited<ReturnType<typeof exchangeRefreshToken>>
    try {
      tokens = await exchangeRefreshToken(info.refresh)
    } catch (error) {
      // offline: an unexpired token still works, otherwise try again later
      if (token && exp > Date.now() + 60_000) return { token, uid: uidOf(token) ?? "" }
      throw error
    }
    if (!tokens) throw new SignedOutError("Your Praex sign-in has expired. Run praex login, then /rc again.")
    token = tokens.id_token
    exp = expiresAt(tokens)
    await writeAuth({ refresh: tokens.refresh_token, access: token, expires: exp }).catch(() => {})
  }
  const uid = uidOf(token, opts.fake)
  if (!uid) throw new SignedOutError()
  return { token, uid }
}

export type StartResult = { ok: true; status: RemoteStatus } | { ok: false; message: string }

export function createRemoteControl(input: {
  directory: string
  version?: string
  dispatch: (req: Request) => Promise<Response>
  onStatus: (s: RemoteStatus) => void
  log?: (line: string) => void
}) {
  let tunnel: RemoteTunnel | undefined
  let session: { title?: string; sessionID?: string; directory?: string } = {}
  let status: RemoteStatus = { state: "off" }
  const report = (s: RemoteStatus) => {
    status = s
    input.onStatus(s)
  }

  return {
    status: () => status,
    async start(): Promise<StartResult> {
      if (tunnel && status.state !== "off" && status.state !== "error") return { ok: true, status }
      let config: ReturnType<typeof relayConfig>
      try {
        config = relayConfig()
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      const verifyPhone = config.fake ? fakePhoneVerifier : firebasePhoneVerifier()
      const next = new RemoteTunnel({
        relayUrl: config.url,
        link: REMOTE_LINK,
        dispatch: input.dispatch,
        credential: (o) => praexCredential({ ...o, fake: config.fake }),
        verifyPhone,
        meta: () => ({
          name: os.hostname().split(".")[0] || "Computer",
          directory: path.basename(session.directory ?? input.directory) || input.directory,
          title: session.title,
          version: input.version,
          // where the phone opens: the web UI's own route for this session (or a new one)
          path: `/${base64Encode(session.directory ?? input.directory)}/session${session.sessionID ? `/${session.sessionID}` : ""}`,
        }),
        onStatus: (s) => {
          if (tunnel === next) report(s)
        },
        grantTtlMs: grantTtlFromEnv(),
        log: input.log,
      })
      tunnel?.stop()
      tunnel = next
      try {
        await next.start()
        return { ok: true, status }
      } catch (error) {
        next.stop()
        if (tunnel === next) tunnel = undefined
        report({ state: "off" })
        if (error instanceof SignedOutError) return { ok: false, message: error.message }
        return { ok: false, message: "Couldn't start Remote Control. Check your connection and try again." }
      }
    },
    stop() {
      const t = tunnel
      tunnel = undefined
      t?.stop()
      report({ state: "off" })
    },
    /** The session open in the TUI, so the phone lists its title and opens straight into it. */
    setSession(next: { title?: string; sessionID?: string; directory?: string }) {
      if (next.title === session.title && next.sessionID === session.sessionID && next.directory === session.directory)
        return
      session = { ...next }
      tunnel?.meta()
    },
  }
}
