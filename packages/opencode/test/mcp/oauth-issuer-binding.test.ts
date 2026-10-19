// GHSA-6qxp-vccf-f47h: stored MCP OAuth credentials are bound to the authorization server
// that issued them. A server that later points the client at a different authorization
// server must never receive the existing refresh token or client secret.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthAuthServerChangedError, McpOAuthProvider } from "../../src/mcp/oauth-provider"

const REFRESH_TOKEN = "rt-legit-secret"
const CLIENT_SECRET = "cs-legit-secret"
const CONFIG_SECRET = "cfg-legit-secret"

type Seen = { method: string; path: string; headers: string; body: string }

function authorizationServer() {
  const seen: Seen[] = []
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: JSON.stringify(Object.fromEntries(req.headers)),
        body: await req.text(),
      })
      const base: string = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        })
      }
      if (url.pathname === "/token" && req.method === "POST") {
        return Response.json({
          access_token: `access-from-${server.port}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `rt-from-${server.port}`,
        })
      }
      if (url.pathname === "/register" && req.method === "POST") {
        return Response.json(
          { client_id: `client-from-${server.port}`, redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"] },
          { status: 201 },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })
  return {
    server,
    seen,
    get url() {
      return `http://127.0.0.1:${server.port}`
    },
  }
}

let legit: ReturnType<typeof authorizationServer>
let evil: ReturnType<typeof authorizationServer>
let resource: ReturnType<typeof Bun.serve>
let pointsTo = ""
let mcpUrl = ""

beforeAll(() => {
  legit = authorizationServer()
  evil = authorizationServer()
  resource = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: mcpUrl, authorization_servers: [pointsTo] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  mcpUrl = `http://127.0.0.1:${resource.port}/mcp`
})

afterAll(() => {
  legit.server.stop(true)
  evil.server.stop(true)
  resource.stop(true)
})

// The real McpAuth store over an in-memory mcp-auth.json.
let raw = ""
const memoryFs = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readJson: (file) =>
        file.endsWith("mcp-auth.json")
          ? Effect.try({
              try: () => {
                if (!raw) throw new Error("mcp-auth.json missing")
                return JSON.parse(raw)
              },
              catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }),
            })
          : fs.readJson(file),
      writeJson: (file, value, mode) =>
        file.endsWith("mcp-auth.json")
          ? Effect.sync(() => {
              raw = JSON.stringify(value)
            })
          : fs.writeJson(file, value, mode),
    })
  }),
).pipe(Layer.provide(FSUtil.defaultLayer))

const store = () =>
  Effect.runPromise(
    McpAuth.Service.use((s) => Effect.succeed(s)).pipe(
      Effect.provide(McpAuth.layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(memoryFs))),
    ),
  )

const NAME = "binding-test"

async function seed(entry: Partial<McpAuth.Entry>) {
  raw = JSON.stringify({
    [NAME]: {
      serverUrl: mcpUrl,
      tokens: { accessToken: "access-old", refreshToken: REFRESH_TOKEN, expiresAt: Date.now() / 1000 - 60 },
      clientInfo: { clientId: "client-legit", clientSecret: CLIENT_SECRET },
      ...entry,
    },
  })
}

function provider(store: McpAuth.Interface, config: ConstructorParameters<typeof McpOAuthProvider>[2] = {}) {
  const redirects: URL[] = []
  const p = new McpOAuthProvider(NAME, mcpUrl, config, { onRedirect: (url) => void redirects.push(url) }, store)
  return { p, redirects }
}

function leaked(seen: Seen[], secrets: string[]) {
  return seen.filter((r) => secrets.some((s) => r.body.includes(s) || r.headers.includes(s) || r.path.includes(s)))
}

const posts = (seen: Seen[]) => seen.filter((r) => r.method === "POST")

beforeEach(() => {
  legit.seen.length = 0
  evil.seen.length = 0
  raw = ""
})

describe("MCP OAuth authorization-server binding", () => {
  test("legitimate refresh at the bound authorization server still works", async () => {
    const s = await store()
    pointsTo = legit.url
    await seed({ authServer: { issuer: legit.url, url: legit.url } })
    const { p } = provider(s)

    expect(await sdkAuth(p, { serverUrl: mcpUrl })).toBe("AUTHORIZED")

    const token = posts(legit.seen).find((r) => r.path === "/token")
    expect(token).toBeDefined()
    const form = new URLSearchParams(token!.body)
    expect(form.get("grant_type")).toBe("refresh_token")
    expect(form.get("refresh_token")).toBe(REFRESH_TOKEN)
    expect(form.get("client_secret")).toBe(CLIENT_SECRET)

    const entry = await Effect.runPromise(s.get(NAME))
    expect(entry?.tokens?.accessToken).toBe(`access-from-${legit.server.port}`)
    expect(entry?.authServer).toEqual({ issuer: legit.url, url: legit.url })
    expect(evil.seen).toHaveLength(0)
  })

  test("a changed authorization server never receives the refresh token or client secret", async () => {
    const s = await store()
    pointsTo = evil.url
    await seed({ authServer: { issuer: legit.url, url: legit.url } })
    const { p, redirects } = provider(s)

    const error = await sdkAuth(p, { serverUrl: mcpUrl }).catch((e) => e)
    expect(error).toBeInstanceOf(McpOAuthAuthServerChangedError)
    expect(String(error.message)).toContain("OAuth")
    expect(String(error.message)).toContain(evil.url)

    // Discovery reads the new server's public metadata; nothing is ever posted to it.
    expect(posts(evil.seen)).toHaveLength(0)
    expect(leaked(evil.seen, [REFRESH_TOKEN, CLIENT_SECRET, "access-old"])).toHaveLength(0)
    expect(legit.seen).toHaveLength(0)
    expect(redirects).toHaveLength(0)

    // The stored credentials for that server are gone; the in-flight sign-in fields are not touched.
    const entry = await Effect.runPromise(s.get(NAME))
    expect(entry?.tokens).toBeUndefined()
    expect(entry?.clientInfo).toBeUndefined()
    expect(entry?.authServer).toBeUndefined()
    expect(entry?.serverUrl).toBe(mcpUrl)

    // A fresh sign-in is now required: the next attempt starts a new registration and
    // redirect at the new server, still without any of the old secrets.
    expect(await sdkAuth(p, { serverUrl: mcpUrl })).toBe("REDIRECT")
    expect(redirects[0]?.origin).toBe(evil.url)
    expect(leaked(evil.seen, [REFRESH_TOKEN, CLIENT_SECRET, "access-old"])).toHaveLength(0)
    expect(posts(evil.seen).map((r) => r.path)).toEqual(["/register"])
  })

  test("a pre-configured client secret is not sent to a changed authorization server", async () => {
    const s = await store()
    pointsTo = evil.url
    await seed({ clientInfo: undefined, authServer: { issuer: legit.url, url: legit.url } })
    const { p } = provider(s, { clientId: "cfg-client", clientSecret: CONFIG_SECRET })

    const error = await sdkAuth(p, { serverUrl: mcpUrl }).catch((e) => e)
    expect(error).toBeInstanceOf(McpOAuthAuthServerChangedError)
    expect(posts(evil.seen)).toHaveLength(0)
    expect(leaked(evil.seen, [REFRESH_TOKEN, CONFIG_SECRET])).toHaveLength(0)
  })

  test("same issuer name served from a different URL is treated as a change", async () => {
    const s = await store()
    pointsTo = evil.url
    // An attacker server could claim the legitimate issuer string in its own metadata;
    // the binding also pins the URL the metadata was fetched from.
    await seed({ authServer: { issuer: evil.url, url: legit.url } })
    const { p } = provider(s)

    expect(await sdkAuth(p, { serverUrl: mcpUrl }).catch((e) => e)).toBeInstanceOf(McpOAuthAuthServerChangedError)
    expect(posts(evil.seen)).toHaveLength(0)
  })

  test("legacy credentials without a recorded issuer are dropped and require a fresh sign-in", async () => {
    const s = await store()
    pointsTo = legit.url
    await seed({})
    const { p, redirects } = provider(s)

    expect(await sdkAuth(p, { serverUrl: mcpUrl })).toBe("REDIRECT")
    expect(redirects[0]?.origin).toBe(legit.url)
    // No refresh was attempted with the unbound refresh token or client secret.
    expect(legit.seen.some((r) => r.path === "/token")).toBe(false)
    expect(leaked(legit.seen, [REFRESH_TOKEN, CLIENT_SECRET])).toHaveLength(0)

    // The fresh registration is bound to the server it came from.
    const entry = await Effect.runPromise(s.get(NAME))
    expect(entry?.tokens).toBeUndefined()
    expect(entry?.clientInfo?.clientId).toBe(`client-from-${legit.server.port}`)
    expect(entry?.authServer).toEqual({ issuer: legit.url, url: legit.url })
  })

  test("before discovery, only the access token is handed out (no refresh token or client secret)", async () => {
    const s = await store()
    await seed({ authServer: { issuer: legit.url, url: legit.url } })
    const { p } = provider(s)

    const tokens = await p.tokens()
    expect(tokens?.access_token).toBe("access-old")
    expect(tokens?.refresh_token).toBeUndefined()
    const client = await p.clientInformation()
    expect(client?.client_id).toBe("client-legit")
    expect(client?.client_secret).toBeUndefined()

    const configured = provider(s, { clientId: "cfg-client", clientSecret: CONFIG_SECRET }).p
    expect((await configured.clientInformation())?.client_secret).toBeUndefined()
  })
})
