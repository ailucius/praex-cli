import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import {
  BAKED_LINEUP,
  freeModelID,
  gatewayURLAllowed,
  hostedLineup,
  hostedProvider,
  otherProviderConfigured,
  parseAccount,
  nextMidnightUTC,
  parseLineup,
  pinGateway,
  PraexCloudAuthPlugin,
  isSignedOutMessage,
  signedOutFetch,
  signedOutMessage,
  trustedGateway,
} from "../../src/plugin/praex-cloud"

const tmpCache = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), "praex-lineup-")), "models.json")
const DEAD = "http://127.0.0.1:9/v1" // discard port: refused instantly, never answers

describe("praex-cloud hosted lineup", () => {
  test("parseLineup keeps id/name/limit, defaults missing fields, rejects junk", () => {
    const l = parseLineup({ data: [{ id: "a", name: "A · free", limit: { context: 1000, output: 10 } }, { id: "b" }, { id: "" }, null, { name: "no-id" }] })!
    expect(Object.keys(l)).toEqual(["a", "b"])
    expect(l.a).toEqual({ name: "A · free", limit: { context: 1000, output: 10 } })
    expect(l.b.name).toBe("b")
    expect(l.b.limit).toEqual({ context: 32768, output: 8192 })
    expect(parseLineup({ data: [] })).toBeUndefined()
    expect(parseLineup({ object: "list" })).toBeUndefined()
    expect(parseLineup("nope")).toBeUndefined()
  })

  test("a stale user block never resurrects a retired model; endpoint and name survive", () => {
    const staging = "https://staging.example/v1"
    const p = hostedProvider(
      { name: "Praex (staging)", options: { baseURL: staging }, models: { "faber-i": { name: "Faber I · Pro" } } },
      BAKED_LINEUP,
    )
    expect(Object.keys(p.models)).toEqual(Object.keys(BAKED_LINEUP))
    expect(p.models["faber-i"]).toBeUndefined()
    expect(p.options.baseURL).toBe(staging)
    expect(p.name).toBe("Praex (staging)")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
  })

  test("no user block → shipped defaults", () => {
    const p = hostedProvider(undefined, BAKED_LINEUP)
    expect(p.name).toBe("Praex")
    expect(p.options.baseURL).toMatch(/^https:\/\/praex-gateway-.*\/v1$/)
    expect(p.models["velox-ii-baked"].name).toBe("Velox III · Free")
    expect(p.models["velox-ii-baked"].limit.context).toBe(131072)
    expect(p.models["faber-ii"].name).toBe("Faber II · Pro")
    expect(p.models["lucia-ii"].name).toBe("Lucia II · Max")
  })

  test("10-22: a model whose lineup input lists image accepts image attachments; the others do not", () => {
    const l = parseLineup({
      data: [
        { id: "velox-ii-baked", name: "Velox III", plan: "free", input: ["text", "image", 7] },
        { id: "faber-ii", name: "Faber II", plan: "pro", input: ["text"] },
        { id: "old", name: "Old" },
      ],
    })!
    expect(l["velox-ii-baked"].input).toEqual(["text", "image"])
    const p = hostedProvider(undefined, l) as any
    expect(p.models["velox-ii-baked"].attachment).toBe(true)
    expect(p.models["velox-ii-baked"].modalities).toEqual({ input: ["text", "image"], output: ["text"] })
    expect(p.models["faber-ii"].attachment).toBeUndefined()
    expect(p.models["old"].modalities).toBeUndefined()
    expect((hostedProvider(undefined, BAKED_LINEUP) as any).models["velox-ii-baked"].attachment).toBe(true)
  })

  test("plain gateway names get their plan suffix, and the free tier is listed first", () => {
    const l = parseLineup({
      data: [
        { id: "faber-ii", name: "Faber II", plan: "pro" },
        { id: "velox-ii-baked", name: "Velox II", plan: "free" },
        { id: "z", name: "Z" },
      ],
    })!
    expect(l["velox-ii-baked"].plan).toBe("free")
    const p = hostedProvider(undefined, l)
    expect(Object.keys(p.models)).toEqual(["velox-ii-baked", "faber-ii", "z"])
    expect(p.models["velox-ii-baked"].name).toBe("Velox II · Free")
    expect(p.models["faber-ii"].name).toBe("Faber II · Pro")
    expect(p.models["z"].name).toBe("Z")
  })

  test("thinking tiers are flagged reasoning with the effort variants switched off", () => {
    const l = parseLineup({
      data: [
        { id: "velox-ii-baked", name: "Velox II", plan: "free", reasoning: false },
        { id: "faber-ii", name: "Faber II · Pro", plan: "pro", reasoning: true },
      ],
    })!
    expect(l["velox-ii-baked"].reasoning).toBeUndefined()
    expect(l["faber-ii"].reasoning).toBe(true)
    const p = hostedProvider(undefined, l) as any
    expect(p.models["velox-ii-baked"].reasoning).toBeUndefined()
    expect(p.models["faber-ii"].reasoning).toBe(true)
    expect(Object.values(p.models["faber-ii"].variants).every((v: any) => v.disabled === true)).toBe(true)
    expect(Object.keys(p.models["faber-ii"].variants)).toEqual(expect.arrayContaining(["low", "medium", "high"]))
  })

  test("live gateway list wins and is written to the cache", async () => {
    const srv = Bun.serve({
      port: 0,
      fetch: () => Response.json({ object: "list", data: [{ id: "x-1", name: "X · free", plan: "free", limit: { context: 4096, output: 512 } }] }),
    })
    try {
      const file = await tmpCache()
      const l = await hostedLineup(`http://127.0.0.1:${srv.port}/v1`, { cacheFile: file })
      expect(l).toEqual({ "x-1": { name: "X · free", plan: "free", limit: { context: 4096, output: 512 } } })
      const c = JSON.parse(await fs.readFile(file, "utf8"))
      expect(c.models["x-1"].name).toBe("X · free")
      expect(c.baseURL).toBe(`http://127.0.0.1:${srv.port}/v1`)
    } finally {
      srv.stop(true)
    }
  })

  test("offline with no cache → baked list, and fast", async () => {
    const t0 = Date.now()
    const l = await hostedLineup(DEAD, { cacheFile: await tmpCache(), timeoutMs: 800 })
    expect(l).toEqual(BAKED_LINEUP)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  test("offline with a cache for the same endpoint → cache, even when stale", async () => {
    const file = await tmpCache()
    await fs.writeFile(file, JSON.stringify({ baseURL: DEAD, fetchedAt: 0, models: { "c-1": { name: "C", limit: { context: 1, output: 1 } } } }))
    const l = await hostedLineup(DEAD, { cacheFile: file, timeoutMs: 500 })
    expect(Object.keys(l)).toEqual(["c-1"])
  })

  test("a cache for a different endpoint is ignored", async () => {
    const file = await tmpCache()
    await fs.writeFile(file, JSON.stringify({ baseURL: "http://other/v1", fetchedAt: Date.now(), models: { "o-1": { name: "O", limit: { context: 1, output: 1 } } } }))
    const l = await hostedLineup(DEAD, { cacheFile: file, timeoutMs: 500 })
    expect(l).toEqual(BAKED_LINEUP)
  })

  test("freeModelID picks plan free, else the '· free' tier, else the first entry", () => {
    expect(freeModelID(BAKED_LINEUP)).toBe("velox-ii-baked")
    expect(freeModelID({ "p": { name: "Faber II", plan: "pro", limit: { context: 1, output: 1 } }, "f": { name: "Velox II", plan: "free", limit: { context: 1, output: 1 } } })).toBe("f")
    expect(freeModelID({ "b": { name: "B · Pro", limit: { context: 1, output: 1 } }, "a": { name: "A · free", limit: { context: 1, output: 1 } } })).toBe("a")
    expect(freeModelID({ "x": { name: "X", limit: { context: 1, output: 1 } } })).toBe("x")
  })

  test("config hook: signed in, Praex free tier is the default model; a user-set model survives", async () => {
    const auth = path.join(Global.Path.data, "auth.json")
    await fs.mkdir(path.dirname(auth), { recursive: true })
    await fs.writeFile(auth, JSON.stringify({ "praex-cloud": { type: "oauth", refresh: "r", access: "a", expires: 0 } }))
    const prev = process.env.PRAEX_GATEWAY_URL
    process.env.PRAEX_GATEWAY_URL = DEAD // loopback http is allowed from the env var
    try {
      const hooks = await PraexCloudAuthPlugin({} as any)
      // DEAD endpoint → baked lineup (or the on-disk cache when one exists for that URL): both name the free tier
      const fresh: any = { provider: {} }
      await hooks.config!(fresh)
      expect(fresh.model).toBe("praex-cloud/velox-ii-baked")
      expect(fresh.provider["praex-cloud"].options.baseURL).toBe(DEAD)
      const mine: any = { model: "google/gemini-3.5-flash", provider: {} }
      await hooks.config!(mine)
      expect(mine.model).toBe("google/gemini-3.5-flash")
    } finally {
      if (prev === undefined) delete process.env.PRAEX_GATEWAY_URL
      else process.env.PRAEX_GATEWAY_URL = prev
      await fs.rm(auth, { force: true })
    }
  })

  test("signed out with another provider set up: Praex is not the default", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "praex-auth-"))
    const authFile = path.join(dir, "auth.json")
    expect(await otherProviderConfigured({ provider: { "praex-cloud": {} } }, { env: {}, authFile })).toBe(false)
    expect(await otherProviderConfigured({}, { env: { GEMINI_API_KEY: "x" }, authFile })).toBe(true)
    expect(await otherProviderConfigured({ provider: { anthropic: {} } }, { env: {}, authFile })).toBe(true)
    await fs.writeFile(authFile, JSON.stringify({ openai: { type: "api", key: "k" } }))
    expect(await otherProviderConfigured({}, { env: {}, authFile })).toBe(true)
  })

  test("signed out: the request is answered locally with the sign-in hint, never sent", async () => {
    const res = await signedOutFetch()
    expect(res.status).toBe(401)
    const body = (await res.json()) as any
    expect(body.error.message).toBe(signedOutMessage())
    expect(body.error.code).toBe("signed_out")
  })

  test("10-22: the signed-out text names the free model and no client-specific command", () => {
    expect(signedOutMessage("Velox IV")).toBe("Sign in to Praex to use Velox IV for free, or pick another model.")
    expect(signedOutMessage()).not.toContain("praex login")
    expect(isSignedOutMessage(signedOutMessage())).toBe(true)
    expect(isSignedOutMessage("Rate limited")).toBe(false)
  })

  test("gateway URL: https only; http just for loopback from the env var", () => {
    expect(gatewayURLAllowed("https://staging.example/v1", false)).toBe(true)
    expect(gatewayURLAllowed("http://evil.example/v1", false)).toBe(false)
    expect(gatewayURLAllowed("http://evil.example/v1", true)).toBe(false)
    expect(gatewayURLAllowed("http://127.0.0.1:8080/v1", false)).toBe(false)
    expect(gatewayURLAllowed("http://127.0.0.1:8080/v1", true)).toBe(true)
    expect(gatewayURLAllowed("http://localhost:8080/v1", true)).toBe(true)
    expect(gatewayURLAllowed("not a url", true)).toBe(false)
  })

  test("a project config can not repoint the gateway or swap the key; global config and env can", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "praex-global-"))
    // nothing set anywhere: the official gateway, and a project override is ignored with a warning
    const none = await trustedGateway({ env: {}, configDir: dir })
    expect(none.baseURL).toMatch(/^https:\/\/praex-gateway-.*\/v1$/)
    const evil = pinGateway({ options: { baseURL: "http://127.0.0.1:18997/v1", apiKey: "stolen" } }, none)
    expect(evil.block.options.baseURL).toBe(none.baseURL)
    expect(evil.block.options.apiKey).toBeUndefined()
    expect(evil.warning).toContain("ignoring")
    // the user's own global config may point at staging over https
    await fs.writeFile(
      path.join(dir, "praex.jsonc"),
      `{ // staging\n "provider": { "praex-cloud": { "options": { "baseURL": "https://staging.example/v1" } } } }`,
    )
    const staging = await trustedGateway({ env: {}, configDir: dir })
    expect(staging.baseURL).toBe("https://staging.example/v1")
    const same = pinGateway({ options: { baseURL: "https://staging.example/v1/" } }, staging)
    expect(same.warning).toBeUndefined()
    // http in the global config is refused (env only, loopback only)
    await fs.writeFile(
      path.join(dir, "praex.jsonc"),
      `{ "provider": { "praex-cloud": { "options": { "baseURL": "http://staging.example/v1" } } } }`,
    )
    const plain = await trustedGateway({ env: {}, configDir: dir })
    expect(plain.baseURL).toBe(none.baseURL)
    expect(pinGateway(undefined, plain).warning).toContain("https")
    // the env var wins
    const local = await trustedGateway({ env: { PRAEX_GATEWAY_URL: "http://127.0.0.1:8080/v1" }, configDir: dir })
    expect(local.baseURL).toBe("http://127.0.0.1:8080/v1")
  })

  test("the Praex token is only ever attached for the gateway origin", async () => {
    const seen: { url: string; auth: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push({ url: new URL(req.url).pathname, auth: req.headers.get("authorization") })
        return new Response("{}")
      },
    })
    const prev = process.env.PRAEX_GATEWAY_URL
    process.env.PRAEX_GATEWAY_URL = `http://127.0.0.1:${server.port}/v1`
    try {
      const hooks = await PraexCloudAuthPlugin({ client: { auth: { set: async () => {} } } } as any)
      await hooks.config!({ provider: { "praex-cloud": { options: { baseURL: "http://localhost:9/v1" } } } } as any)
      const auth = { type: "oauth", refresh: "r", access: "TOKEN", expires: Date.now() + 3_600_000 }
      const opts: any = await hooks.auth!.loader!(async () => auth as any, {} as any)
      await opts.fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST" })
      await opts.fetch(`http://localhost:${server.port}/elsewhere`, { method: "POST" })
      // (the lineup fetch to /v1/models is public and carries no token either)
      expect(seen.filter((r) => r.url !== "/v1/models")).toEqual([
        { url: "/v1/chat/completions", auth: "Bearer TOKEN" },
        { url: "/elsewhere", auth: null },
      ])
    } finally {
      if (prev === undefined) delete process.env.PRAEX_GATEWAY_URL
      else process.env.PRAEX_GATEWAY_URL = prev
      server.stop(true)
    }
  })

  test("never signed in: the prompt is answered locally and never reaches the gateway", async () => {
    const seen: string[] = []
    const server = Bun.serve({ port: 0, fetch(req) { seen.push(new URL(req.url).pathname); return new Response("{}") } })
    const prev = process.env.PRAEX_GATEWAY_URL
    process.env.PRAEX_GATEWAY_URL = `http://127.0.0.1:${server.port}/v1`
    try {
      const hooks = await PraexCloudAuthPlugin({ client: { auth: { set: async () => {} } } } as any)
      await hooks.config!({ provider: {} } as any)
      const opts: any = await hooks.auth!.loader!(async () => ({ type: "none" }) as any, {} as any)
      expect(opts.signedIn).toBe(false)
      const res: Response = await opts.fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, { method: "POST", body: "{}" })
      expect(res.status).toBe(401)
      expect(((await res.json()) as any).error.message).toBe(signedOutMessage())
      expect(seen.filter((p) => p !== "/v1/models")).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.PRAEX_GATEWAY_URL
      else process.env.PRAEX_GATEWAY_URL = prev
      server.stop(true)
    }
  })

  test("small model hook: titles run on the free tier, other providers untouched", async () => {
    const hooks = await PraexCloudAuthPlugin({} as any)
    const models = { "faber-ii": { id: "faber-ii" }, "velox-ii-baked": { id: "velox-ii-baked" } }
    const out: any = { model: undefined }
    await hooks["experimental.provider.small_model"]!({ provider: { id: "praex-cloud", models } } as any, out)
    expect(out.model?.id).toBe("velox-ii-baked")
    const other: any = { model: undefined }
    await hooks["experimental.provider.small_model"]!({ provider: { id: "google", models } } as any, other)
    expect(other.model).toBeUndefined()
  })
})

describe("praex-cloud account (10-22)", () => {
  const now = new Date("2026-10-22T19:00:00Z")
  test("parses the gateway plan and works out the share left, counting replies in flight", () => {
    const account = parseAccount(
      { plan: "free", used: 800_000, inFlight: 50_000, allowance: 1_000_000, resetsAt: "2026-10-23T00:00:00.000Z", email: "a@b.c", name: "A", sources: ["stripe", 3] },
      now,
    )
    expect(account.left).toBeCloseTo(0.15, 6)
    expect({ ...account, left: undefined }).toEqual({
      signedIn: true,
      plan: "free",
      used: 800_000,
      inFlight: 50_000,
      allowance: 1_000_000,
      left: undefined,
      resetsAt: "2026-10-23T00:00:00.000Z",
      email: "a@b.c",
      name: "A",
      sources: ["stripe"],
    })
  })

  test("an older gateway without resetsAt, email or name: reset at the next midnight UTC", () => {
    const account = parseAccount({ plan: "pro", used: 2_000_000, inFlight: 0, allowance: 1_000_000, sources: [] }, now)
    expect(account.resetsAt).toBe(nextMidnightUTC(now))
    expect(account.resetsAt).toBe("2026-10-23T00:00:00.000Z")
    expect(account.left).toBe(0)
    expect(account.email).toBeUndefined()
  })
})

