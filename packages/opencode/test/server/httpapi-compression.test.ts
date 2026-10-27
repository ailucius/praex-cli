import { afterEach, describe, expect, test } from "bun:test"
import { gunzipSync, inflateSync } from "node:zlib"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default().app
}

// /config echoes the config back. Padding the config pushes the response body
// well past the 1024 B threshold so we can observe compression behavior.
function fatConfig() {
  const instructions: string[] = []
  for (let i = 0; i < 50; i++) {
    instructions.push(`padding-instruction-${i}-${"x".repeat(40)}`)
  }
  return {
    formatter: false,
    lsp: false,
    username: "compression-test-user",
    instructions,
  }
}

describe("HttpApi compression", () => {
  describe("encodes responses", () => {
    test("gzips JSON when Accept-Encoding includes gzip and body exceeds threshold", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("gzip")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = gunzipSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
      expect(compressed.byteLength).toBeLessThan(decompressed.byteLength)
    })

    test("uses deflate when only deflate is acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "deflate" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("deflate")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = inflateSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
    })

    test("prefers gzip when both gzip and deflate are acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip, deflate" },
      })
      expect(response.headers.get("content-encoding")).toBe("gzip")
    })

    test("does not include the original Content-Length when compressed", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      const compressed = new Uint8Array(await response.arrayBuffer())
      const declared = response.headers.get("content-length")
      // Either absent (transfer-encoding chunked) or matches the compressed length.
      if (declared !== null) expect(Number(declared)).toBe(compressed.byteLength)
    })
  })

  describe("skips", () => {
    test("when no Accept-Encoding header is present", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when Accept-Encoding only allows unsupported encodings", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "br" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when the response body is below the 1024-byte threshold", async () => {
      // 10-26 (audit R8-15): /path is a small JSON response (a few paths, ~200 bytes). A bare /config is not:
      // the built-in praex-cloud provider entry alone is ~900 bytes, which puts it over the threshold.
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const response = await app().request("/path", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      // A compressible type, so only the size can keep it uncompressed.
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = new Uint8Array(await response.arrayBuffer())
      // Measure the uncompressed body: a gzipped one would hide a response that grew past the threshold.
      const raw = response.headers.get("content-encoding") === "gzip" ? gunzipSync(body) : body
      expect(raw.byteLength).toBeLessThan(1024)
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("HEAD requests", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        method: "HEAD",
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })
  })

  // 10-27 (audit9 R8-14): Accept-Encoding was matched by substring, so q-values were ignored and
  // `gzip;q=0` (explicitly unacceptable) still got gzip.
  describe("Accept-Encoding quality values (audit9 R8-14)", () => {
    test("gzip;q=0, deflate;q=1 gets deflate, never the excluded gzip", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip;q=0, deflate;q=1" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("deflate")
      const json = JSON.parse(new TextDecoder().decode(inflateSync(new Uint8Array(await response.arrayBuffer()))))
      expect(json).toMatchObject({ username: "compression-test-user" })
    })

    const cases: [header: string, expected: string | null][] = [
      ["GZIP;Q=0, Deflate", "deflate"],
      ["gzip;q=0, deflate;q=0", null],
      ["gzip ; q=0.0 , deflate", "deflate"],
      ["deflate;q=1, gzip;q=0.5", "deflate"],
      ["gzip;q=0.8, deflate;q=0.8", "gzip"],
      ["*", "gzip"],
      ["*;q=0.5, gzip;q=0", "deflate"],
      ["*;q=0", null],
      ["identity;q=1, gzip;q=0.5", null],
      ["x-gzip", "gzip"],
      ["gzip;q=bogus, deflate;q=0.1", "deflate"],
    ]
    for (const [header, expected] of cases) {
      test(`Accept-Encoding "${header}" -> ${expected ?? "uncompressed"}`, async () => {
        await using tmp = await tmpdir({ config: fatConfig() })
        const response = await app().request("/config", {
          headers: { "x-opencode-directory": tmp.path, "accept-encoding": header },
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBe(expected)
      })
    }
  })

  describe("streaming exclusions", () => {
    test("/event SSE is not compressed", async () => {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const controller = new AbortController()
      const response = await app().request("/event", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })

    test("/global/event SSE is not compressed", async () => {
      const controller = new AbortController()
      const response = await app().request("/global/event", {
        headers: { "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })
  })
})
