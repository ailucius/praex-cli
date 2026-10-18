import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BAKED_LINEUP, freeModelID, hostedLineup, hostedProvider, parseLineup, PraexCloudAuthPlugin } from "../../src/plugin/praex-cloud"

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
    expect(p.models["velox-ii-baked"].name).toBe("Velox II · free")
    expect(p.models["faber-ii"].name).toBe("Faber II · Pro")
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
    expect(p.models["velox-ii-baked"].name).toBe("Velox II · free")
    expect(p.models["faber-ii"].name).toBe("Faber II · Pro")
    expect(p.models["z"].name).toBe("Z")
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

  test("config hook: Praex free tier is the default model; a user-set model survives", async () => {
    const hooks = await PraexCloudAuthPlugin({} as any)
    // DEAD endpoint → baked lineup (or the on-disk cache when one exists for that URL): both name the free tier
    const fresh: any = { provider: { "praex-cloud": { options: { baseURL: DEAD } } } }
    await hooks.config!(fresh)
    expect(fresh.model).toBe("praex-cloud/velox-ii-baked")
    const mine: any = { model: "google/gemini-3.5-flash", provider: { "praex-cloud": { options: { baseURL: DEAD } } } }
    await hooks.config!(mine)
    expect(mine.model).toBe("google/gemini-3.5-flash")
  })
})
