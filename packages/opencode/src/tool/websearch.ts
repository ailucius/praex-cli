import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { checksum } from "@opencode-ai/core/util/encode"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { praexAccessToken, trustedGateway } from "@/plugin/praex-cloud"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel", "praex"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

// 10-20 audit F21: sessions on a Praex model search through the gateway (POST /v1/search with the
// user's Praex token; Tavily, then DuckDuckGo/Wikipedia), never Exa or Parallel directly, so no
// query, session id or model name reaches a third party from this machine.
export function isPraexModel(extra: Tool.Context["extra"]) {
  const model = extra?.model
  const providerID = model && typeof model === "object" && "providerID" in model ? model.providerID : undefined
  return typeof providerID === "string" && providerID.startsWith("praex")
}

export const PRAEX_SEARCH_SIGNED_OUT = "Web search on Praex needs a Praex account. Sign in with praex auth login."

type SearchHit = { title?: unknown; url?: unknown; snippet?: unknown }
export function formatPraexHits(body: unknown): string | undefined {
  const results = (body as { results?: SearchHit[] } | undefined)?.results
  if (!Array.isArray(results) || !results.length) return undefined
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  return results
    .map((r, i) => [`${i + 1}. ${text(r.title) || text(r.url)}`, text(r.url), text(r.snippet)].filter(Boolean).join("\n"))
    .join("\n\n")
}

export const praexSearch = (http: HttpClient.HttpClient, query: string) =>
  Effect.gen(function* () {
    const token = yield* Effect.promise(() => praexAccessToken())
    if (!token) return yield* Effect.die(new Error(PRAEX_SEARCH_SIGNED_OUT))
    const { baseURL } = yield* Effect.promise(() => trustedGateway())
    const request = yield* HttpClientRequest.post(`${baseURL.replace(/\/+$/, "")}/search`).pipe(
      HttpClientRequest.setHeaders({ authorization: `Bearer ${token}` }),
      HttpClientRequest.bodyJson({ query }),
      Effect.orDie,
    )
    const response = yield* http.execute(request).pipe(
      Effect.timeoutOrElse({ duration: "25 seconds", orElse: () => Effect.die(new Error("Web search timed out")) }),
    )
    const body = (yield* response.json.pipe(Effect.orElseSucceed(() => ({})))) as any
    if (response.status === 401) return yield* Effect.die(new Error(PRAEX_SEARCH_SIGNED_OUT))
    if (response.status >= 400) {
      const message = typeof body?.error?.message === "string" && body.error.message ? body.error.message : undefined
      return yield* Effect.die(new Error(message ?? `Web search failed (${response.status}). Try again in a moment.`))
    }
    return formatPraexHits(body)
  })

export function selectWebSearchProvider(sessionID: string, flags = { exa: false, parallel: false }): WebSearchProvider {
  const override = process.env.OPENCODE_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return override
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"

  return Number.parseInt(checksum(sessionID) ?? "0", 36) % 2 === 0 ? "exa" : "parallel"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "praex") return "Web Search"
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `praex/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "praex") return praexSearch(http, params.query)
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        // no session id to a third party (10-20 audit F21)
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const provider: WebSearchProvider = isPraexModel(ctx.extra)
            ? "praex"
            : selectWebSearchProvider(ctx.sessionID, {
                exa: flags.enableExa,
                parallel: flags.enableParallel,
              })
          const title = webSearchProviderLabel(provider)
          yield* ctx.metadata({ title: `${title} "${params.query}"`, metadata: { provider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider,
            },
          })

          const result = yield* callProvider(http, provider, params, ctx)

          return {
            output: result ?? "No search results found. Please try a different query.",
            title: `${title}: ${params.query}`,
            metadata: { provider },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
