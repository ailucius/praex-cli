import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Global } from "@opencode-ai/core/global"
import { parseResponse } from "../../src/tool/mcp-websearch"
import {
  formatPraexHits,
  isPraexModel,
  PRAEX_SEARCH_SIGNED_OUT,
  praexSearch,
  selectWebSearchProvider,
  webSearchModelName,
  webSearchProviderLabel,
} from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
  })

  test("is only enabled for opencode or explicit websearch provider flags", () => {
    expect(webSearchEnabled(ProviderV2.ID.opencode, { exa: false, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: false })).toBe(false)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: true, parallel: false })).toBe(true)
    expect(webSearchEnabled(ProviderV2.ID.openai, { exa: false, parallel: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})

describe("websearch on Praex models goes through the gateway", () => {
  test("Praex providers are detected from the session model", () => {
    expect(isPraexModel({ model: { providerID: "praex-cloud", id: "velox-ii" } })).toBe(true)
    expect(isPraexModel({ model: { providerID: "openai", id: "gpt-5" } })).toBe(false)
    expect(isPraexModel(undefined)).toBe(false)
  })

  test("gateway hits are formatted as a numbered list", () => {
    expect(formatPraexHits({ results: [{ title: "Bun", url: "https://bun.sh", snippet: "fast" }] })).toBe(
      "1. Bun\nhttps://bun.sh\nfast",
    )
    expect(formatPraexHits({ results: [] })).toBeUndefined()
  })

  test("POST /v1/search with the Praex token and only the query; signed out never calls out", async () => {
    const auth = path.join(Global.Path.data, "auth.json")
    const seen: { url: string; auth?: string; body: string }[] = []
    const client = HttpClient.make((req) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          req,
          new Response(JSON.stringify({ query: "q", results: [{ title: "T", url: "https://t.example", snippet: "s" }] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const body = (req.body as any)?.body
            seen.push({ url: req.url, auth: req.headers["authorization"], body: new TextDecoder().decode(body) })
          }),
        ),
      ),
    )
    await fs.rm(auth, { force: true })
    const out = await Effect.runPromiseExit(praexSearch(client, "bun test"))
    expect(out._tag).toBe("Failure")
    expect(String((out as any).cause)).toContain(PRAEX_SEARCH_SIGNED_OUT)
    expect(seen).toEqual([])

    await fs.mkdir(path.dirname(auth), { recursive: true })
    await fs.writeFile(
      auth,
      JSON.stringify({ "praex-cloud": { type: "oauth", refresh: "r", access: "TOKEN", expires: Date.now() + 3_600_000 } }),
    )
    try {
      const text = await Effect.runPromise(praexSearch(client, "bun test"))
      expect(text).toBe("1. T\nhttps://t.example\ns")
      expect(seen).toHaveLength(1)
      expect(seen[0].url).toMatch(/^https:\/\/praex-gateway-.*\/v1\/search$/)
      expect(seen[0].auth).toBe("Bearer TOKEN")
      expect(JSON.parse(seen[0].body)).toEqual({ query: "bun test" })
    } finally {
      await fs.rm(auth, { force: true })
    }
  })
})
