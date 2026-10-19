// Praex Share: `/share` uploads a read-only snapshot of the session to the Praex gateway
// (POST /v1/share) and gets back a praex.ai/s/<id> link. It is a snapshot, not a live sync:
// nothing is sent until the user asks, and asking again updates the same link. `/unshare`
// deletes it (DELETE /v1/share/<id>). Sharing needs a Praex account (`praex login`); the ID
// token is the same one the praex-cloud provider uses. The share id is kept per session in
// the local session_share table. No request ever goes anywhere but the Praex gateway.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/layer-node-platform"
import type * as SDK from "@opencode-ai/sdk/v2"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Effect, Layer, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Config } from "@/config/config"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { exchangeRefreshToken, expiresAt, hostedBaseURL } from "@/plugin/praex-cloud"
import { buildSnapshot } from "./snapshot"

const PRAEX_PROVIDER = "praex-cloud"
const REFRESH_SKEW_MS = 60_000

/** A failure with a sentence the user can act on; the TUI and `run` print `message` as is. */
export class ShareError extends Schema.TaggedErrorClass<ShareError>()("ShareError", {
  message: Schema.String,
}) {}

export const NOT_SIGNED_IN = "Run `praex login` to share sessions."

export type Share = { id: string; url: string }

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly create: (sessionID: SessionID) => Effect.Effect<Share, ShareError>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void, ShareError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShareNext") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const cfg = yield* Config.Service
    const { db } = yield* Database.Service
    const http = yield* HttpClient.HttpClient
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    const fail = (message: string) => Effect.fail(new ShareError({ message }))

    // The gateway the praex-cloud provider talks to (a config override, e.g. staging, applies here too).
    const gateway = Effect.fn("ShareNext.gateway")(function* () {
      const conf = yield* cfg.get()
      const user = (conf.provider as Record<string, any> | undefined)?.[PRAEX_PROVIDER]
      return hostedBaseURL(user).replace(/\/+$/, "")
    })

    // A fresh Firebase ID token for the signed-in Praex account, refreshed when it is about to expire.
    const token = Effect.fn("ShareNext.token")(function* () {
      const info = yield* auth.get(PRAEX_PROVIDER).pipe(Effect.orElseSucceed(() => undefined))
      if (!info || info.type !== "oauth" || !info.refresh) return yield* fail(NOT_SIGNED_IN)
      if (info.access && info.expires > Date.now() + REFRESH_SKEW_MS) return info.access
      const fresh = yield* Effect.tryPromise(() => exchangeRefreshToken(info.refresh)).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (!fresh) return yield* fail("Your Praex sign-in has expired. Run `praex login`, then share again.")
      yield* auth
        .set(PRAEX_PROVIDER, new Auth.Oauth({ type: "oauth", refresh: fresh.refresh_token, access: fresh.id_token, expires: expiresAt(fresh) }))
        .pipe(Effect.ignore)
      return fresh.id_token
    })

    const call = Effect.fn("ShareNext.call")(function* (req: HttpClientRequest.HttpClientRequest) {
      const res = yield* http
        .execute(req)
        .pipe(Effect.catch(() => fail("Couldn't reach Praex. Check your connection and try again.")))
      const body = (yield* res.json.pipe(Effect.orElseSucceed(() => ({})))) as any
      return { status: res.status, body }
    })
    const gatewayMessage = (body: any, fallback: string) =>
      typeof body?.error?.message === "string" && body.error.message ? body.error.message : fallback

    const stored = Effect.fnUntraced(function* (sessionID: SessionID) {
      const row = yield* db
        .select()
        .from(SessionShareTable)
        .where(eq(SessionShareTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? ({ id: row.id, url: row.url } satisfies Share) : undefined
    })

    // The label of the model that answered last ("Velox II"), falling back to its id.
    const label = Effect.fnUntraced(function* (messages: { info: SDK.Message }[]) {
      const last = messages.findLast((m) => m.info.role === "assistant")?.info as SDK.AssistantMessage | undefined
      if (!last) return ""
      const model = yield* provider
        .getModel(ProviderV2.ID.make(last.providerID), ModelV2.ID.make(last.modelID))
        .pipe(Effect.orElseSucceed(() => undefined))
      return model?.name ?? last.modelID
    })

    const init = Effect.fn("ShareNext.init")(function* () {})

    const create = Effect.fn("ShareNext.create")(function* (sessionID: SessionID) {
      const bearer = yield* token()
      const info = yield* session.get(sessionID).pipe(Effect.catch(() => fail("That session no longer exists.")))
      const messages = (yield* session
        .messages({ sessionID })
        .pipe(Effect.catch(() => fail("Couldn't read this session.")))) as unknown as { info: SDK.Message; parts: SDK.Part[] }[]
      const previous = yield* stored(sessionID)
      const snapshot = buildSnapshot({
        session: info,
        messages,
        model: yield* label(messages),
        id: previous?.id,
        directory: info.directory,
      })
      if (!snapshot.messages.length) return yield* fail("Nothing to share yet. Send a message first.")

      const base = yield* gateway()
      const request = yield* HttpClientRequest.post(`${base}/share`).pipe(
        HttpClientRequest.setHeaders({ authorization: `Bearer ${bearer}` }),
        HttpClientRequest.bodyJson(snapshot),
        Effect.orDie,
      )
      const { status, body } = yield* call(request)
      if (status === 401) return yield* fail(NOT_SIGNED_IN)
      if (status >= 400 || typeof body?.id !== "string" || typeof body?.url !== "string")
        return yield* fail(gatewayMessage(body, "Couldn't create the share link. Try again in a minute."))

      const result: Share = { id: body.id, url: body.url }
      yield* db
        .insert(SessionShareTable)
        .values({ session_id: sessionID, id: result.id, secret: "", url: result.url })
        .onConflictDoUpdate({ target: SessionShareTable.session_id, set: { id: result.id, secret: "", url: result.url } })
        .run()
        .pipe(Effect.orDie)
      return result
    })

    const remove = Effect.fn("ShareNext.remove")(function* (sessionID: SessionID) {
      const share = yield* stored(sessionID)
      if (!share) return
      const bearer = yield* token()
      const base = yield* gateway()
      const { status, body } = yield* call(
        HttpClientRequest.delete(`${base}/share/${encodeURIComponent(share.id)}`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${bearer}` }),
        ),
      )
      if (status === 401) return yield* fail(NOT_SIGNED_IN)
      // 404: already gone on the server. Either way the local link is forgotten.
      if (status >= 400 && status !== 404)
        return yield* fail(gatewayMessage(body, "Couldn't remove the share link. Try again in a minute."))
      yield* db.delete(SessionShareTable).where(eq(SessionShareTable.session_id, sessionID)).run().pipe(Effect.orDie)
    })

    return Service.of({ init, create, remove })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Session.defaultLayer),
)

export const node = LayerNode.make(layer, [Auth.node, Config.node, Database.node, httpClient, Provider.node, Session.node])

export * as ShareNext from "./share-next"
