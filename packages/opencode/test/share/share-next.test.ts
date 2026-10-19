import { beforeEach, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

import { Auth } from "@/auth"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ShareNext } from "@/share/share-next"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const env = LayerNode.buildLayer(CrossSpawnSpawner.node)
const it = testEffect(env)

const GATEWAY = "https://praex-gateway-384599766402.us-central1.run.app/v1"

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )

// The model catalogue refresh shares the HTTP client; answer it here so tests only see share traffic.
const catalogue = (req: HttpClientRequest.HttpClientRequest) => req.url.endsWith("/api.json")

function layer(client: HttpClient.HttpClient) {
  const filtered = HttpClient.make((req) =>
    catalogue(req) ? Effect.succeed(json(req, {}, 404)) : client.execute(req),
  )
  return LayerNode.buildLayer(
    LayerNode.group([ShareNext.node, Session.node, SessionProjector.node, Auth.node, Database.node]),
    { replacements: [LayerNode.replace(httpClient, Layer.succeed(HttpClient.HttpClient, filtered))] },
  )
}

const row = (id: SessionID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db.select().from(SessionShareTable).where(eq(SessionShareTable.session_id, id)).get().pipe(Effect.orDie)
  })

const signIn = Auth.Service.use((auth) =>
  auth.set(
    "praex-cloud",
    new Auth.Oauth({ type: "oauth", refresh: "refresh-token", access: "id-token-1", expires: Date.now() + 30 * 60_000 }),
  ),
)

const body = (req: HttpClientRequest.HttpClientRequest) =>
  req.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(req.body.body)) : undefined

// One user turn and one assistant turn that read a file (with output) and ran a command.
const conversation = Effect.fn("Test.conversation")(function* (title = "Fix the login bug") {
  const session = yield* Session.Service
  const info = yield* session.create({ title })
  const user = MessageID.ascending()
  yield* session.updateMessage({
    id: user,
    sessionID: info.id,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: "praex-cloud", modelID: "velox-ii-baked" },
    tools: {},
  } as unknown as SessionV1.Info)
  yield* session.updatePart({ id: PartID.ascending(), sessionID: info.id, messageID: user, type: "text", text: "why does login fail?" })
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: info.id,
    messageID: user,
    type: "text",
    synthetic: true,
    text: "Called the Read tool with the following input: SECRET FILE BODY",
  })
  const reply = MessageID.ascending()
  yield* session.updateMessage({
    id: reply,
    sessionID: info.id,
    role: "assistant",
    time: { created: Date.now() },
    parentID: user,
    modelID: ModelV2.ID.make("velox-ii-baked"),
    providerID: ProviderV2.ID.make("praex-cloud"),
    mode: "",
    agent: "build",
    path: { cwd: info.directory, root: info.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as SessionV1.Info)
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID: info.id,
    messageID: reply,
    type: "tool",
    callID: "c1",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: `${info.directory}/src/auth.ts` },
      output: "export const TOKEN_FILE_CONTENTS = 1",
      title: "src/auth.ts",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  } as unknown as SessionV1.Part)
  yield* session.updatePart({ id: PartID.ascending(), sessionID: info.id, messageID: reply, type: "text", text: "The token expired." })
  return info
})

beforeEach(async () => {
  await resetDatabase()
})

describe("ShareNext (Praex Share)", () => {
  it.live("refuses with one plain sentence when not signed in, and sends nothing", () =>
    provideTmpdirInstance(() => {
      const seen: string[] = []
      const client = HttpClient.make((req) => (seen.push(req.url), Effect.succeed(json(req, {}))))
      return Effect.gen(function* () {
        const info = yield* conversation()
        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(info.id)))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("Run `praex login` to share sessions.")
        expect(seen).toEqual([])
        expect(yield* row(info.id)).toBeUndefined()
      }).pipe(Effect.provide(layer(client)))
    }),
  )

  it.live("posts a compact snapshot to the Praex gateway and stores the link", () =>
    provideTmpdirInstance(() => {
      const seen: HttpClientRequest.HttpClientRequest[] = []
      const client = HttpClient.make((req) => {
        seen.push(req)
        return Effect.succeed(json(req, { id: "AbCdEfGhIjKlMnOpQrStUv", url: "https://praex.ai/s/AbCdEfGhIjKlMnOpQrStUv" }, 201))
      })
      return Effect.gen(function* () {
        yield* signIn
        const info = yield* conversation()
        const result = yield* (yield* ShareNext.Service).create(info.id)
        expect(result).toEqual({ id: "AbCdEfGhIjKlMnOpQrStUv", url: "https://praex.ai/s/AbCdEfGhIjKlMnOpQrStUv" })

        expect(seen).toHaveLength(1)
        expect(seen[0].method).toBe("POST")
        expect(seen[0].url).toBe(`${GATEWAY}/share`)
        expect(seen[0].headers["authorization"]).toBe("Bearer id-token-1")
        const sent = body(seen[0])
        expect(sent.title).toBe("Fix the login bug")
        expect(sent.id).toBeUndefined()
        expect(sent.messages).toEqual([
          { role: "user", text: "why does login fail?" },
          { role: "assistant", text: "The token expired.", tools: ["Read src/auth.ts"] },
        ])
        // never tool output, never synthetic file bodies
        expect(JSON.stringify(sent)).not.toContain("TOKEN_FILE_CONTENTS")
        expect(JSON.stringify(sent)).not.toContain("SECRET FILE BODY")

        const stored = yield* row(info.id)
        expect(stored?.id).toBe("AbCdEfGhIjKlMnOpQrStUv")
        expect(stored?.url).toBe("https://praex.ai/s/AbCdEfGhIjKlMnOpQrStUv")
      }).pipe(Effect.provide(layer(client)))
    }),
  )

  it.live("sharing again sends the stored id so the same link is updated", () =>
    provideTmpdirInstance(() => {
      const sent: any[] = []
      const client = HttpClient.make((req) => {
        sent.push(body(req))
        return Effect.succeed(json(req, { id: "AbCdEfGhIjKlMnOpQrStUv", url: "https://praex.ai/s/AbCdEfGhIjKlMnOpQrStUv" }))
      })
      return Effect.gen(function* () {
        yield* signIn
        const info = yield* conversation()
        const svc = yield* ShareNext.Service
        yield* svc.create(info.id)
        yield* svc.create(info.id)
        expect(sent.map((b) => b.id)).toEqual([undefined, "AbCdEfGhIjKlMnOpQrStUv"])
      }).pipe(Effect.provide(layer(client)))
    }),
  )

  it.live("a gateway refusal surfaces its message and stores nothing", () =>
    provideTmpdirInstance(() => {
      const client = HttpClient.make((req) =>
        Effect.succeed(json(req, { error: { message: "This session is too large to share.", type: "praex_gateway" } }, 413)),
      )
      return Effect.gen(function* () {
        yield* signIn
        const info = yield* conversation()
        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(info.id)))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("This session is too large to share.")
        expect(yield* row(info.id)).toBeUndefined()
      }).pipe(Effect.provide(layer(client)))
    }),
  )

  it.live("an empty session is not uploaded", () =>
    provideTmpdirInstance(() => {
      const seen: string[] = []
      const client = HttpClient.make((req) => (seen.push(req.url), Effect.succeed(json(req, {}))))
      return Effect.gen(function* () {
        yield* signIn
        const info = yield* (yield* Session.Service).create({ title: "empty" })
        const exit = yield* ShareNext.Service.use((svc) => Effect.exit(svc.create(info.id)))
        expect(JSON.stringify(exit)).toContain("Nothing to share yet.")
        expect(seen).toEqual([])
      }).pipe(Effect.provide(layer(client)))
    }),
  )

  it.live("unshare deletes the link on the gateway and forgets it locally (404 counts as gone)", () =>
    provideTmpdirInstance(() => {
      const seen: Array<[string, string]> = []
      let deleteStatus = 200
      const client = HttpClient.make((req) => {
        seen.push([req.method, req.url])
        if (req.method === "DELETE") return Effect.succeed(json(req, deleteStatus === 200 ? { ok: true } : { error: { message: "gone" } }, deleteStatus))
        return Effect.succeed(json(req, { id: "AbCdEfGhIjKlMnOpQrStUv", url: "https://praex.ai/s/AbCdEfGhIjKlMnOpQrStUv" }, 201))
      })
      return Effect.gen(function* () {
        yield* signIn
        const info = yield* conversation()
        const svc = yield* ShareNext.Service
        yield* svc.create(info.id)
        yield* svc.remove(info.id)
        expect(yield* row(info.id)).toBeUndefined()
        expect(seen).toEqual([
          ["POST", `${GATEWAY}/share`],
          ["DELETE", `${GATEWAY}/share/AbCdEfGhIjKlMnOpQrStUv`],
        ])

        deleteStatus = 404
        yield* svc.create(info.id)
        yield* svc.remove(info.id)
        expect(yield* row(info.id)).toBeUndefined()
        // every request went to the Praex gateway, none to upstream share hosts
        expect(seen.every(([, url]) => url.startsWith(GATEWAY))).toBe(true)
      }).pipe(Effect.provide(layer(client)))
    }),
  )

  it.live("unshare without a link is a no-op with no request", () =>
    provideTmpdirInstance(() => {
      const seen: string[] = []
      const client = HttpClient.make((req) => (seen.push(req.url), Effect.succeed(json(req, {}))))
      return Effect.gen(function* () {
        const info = yield* (yield* Session.Service).create({ title: "never shared" })
        yield* (yield* ShareNext.Service).remove(info.id)
        expect(seen).toEqual([])
      }).pipe(Effect.provide(layer(client)))
    }),
  )
})
