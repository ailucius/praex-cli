import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Context } from "effect"
import { Config } from "@/config/config"
import { ShareNext } from "./share-next"

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, ShareNext.ShareError>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, ShareNext.ShareError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service

    // Praex Share is a snapshot the user asks for: running it again refreshes the same link.
    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled")
        return yield* new ShareNext.ShareError({ message: "Sharing is turned off in your config (\"share\": \"disabled\")." })
      const result = yield* shareNext.create(sessionID)
      yield* session.setShare({ sessionID, share: { url: result.url } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
    })

    // Nothing is ever shared automatically: "share": "auto" and OPENCODE_AUTO_SHARE are ignored.
    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      return yield* session.create(input)
    })

    return Service.of({ create, share, unshare })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(ShareNext.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export const node = LayerNode.make(layer, [Config.node, Session.node, ShareNext.node])

export * as SessionShare from "./session"
