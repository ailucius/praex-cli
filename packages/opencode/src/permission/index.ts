import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionDiff } from "./diff"
import { Guard } from "./guard"
import { ReadOnly } from "./readonly"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Database } from "@opencode-ai/core/database/database"

export const Event = {
  Asked: EventV2.define({ type: "permission.asked", schema: PermissionV1.Request.fields }),
  Replied: EventV2.define({
    type: "permission.replied",
    schema: {
      sessionID: PermissionV1.Request.fields.sessionID,
      requestID: PermissionV1.ID,
      reply: PermissionV1.Reply,
    },
  }),
}

export type SavedRule = { id: string; permission: string; pattern: string }

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
  /** "Allow always" rules saved for this project (10-22). */
  readonly saved: () => Effect.Effect<ReadonlyArray<SavedRule>>
  readonly forget: (id: string) => Effect.Effect<void>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
  // 10-22: "Allow always" used to last until Praex restarted. It is now saved for the project (the
  // permission table, keyed by project) and read back here. Edits stay for this run, like Claude Code's
  // "allow edits this session"; a folder outside git (the shared "global" project) keeps them in memory.
  // The destructive-action guard reads only "destructive" rules, which are never saved, so it still
  // asks for `git push --force` even under a saved `git push *`.
  saved: PermissionV1.Rule[]
  projectID: string
}

const NOT_SAVED = new Set(["edit", Guard.ID, ReadOnly.ID])

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const store = yield* PermissionSaved.Service
    const savedRules = (projectID: string) =>
      store.list({ projectID: projectID as never }).pipe(
        Effect.map((rows) =>
          rows
            .filter((row) => !NOT_SAVED.has(row.action))
            .map((row): PermissionV1.Rule => ({ permission: row.action, pattern: row.resource, action: "allow" })),
        ),
      )
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const projectID = ctx.project.id
        const state: State = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
          saved: projectID === "global" ? [] : yield* savedRules(projectID),
          projectID,
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending, saved } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        // 10-28: a deny in the agent, config or session rules holds even after an earlier "Allow always" (an edit
        // approved in build mode no longer lets the plan agent edit)
        const own = evaluate(request.permission, pattern, ruleset)
        const rule = own.action === "deny" ? own : evaluate(request.permission, pattern, ruleset, saved, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      // Read-only shell commands (see ./readonly) run without asking when a "readonly" allow rule is set
      // (the TUI's manual mode). The guard below still has the last word.
      if (needsAsk && (yield* ReadOnly.evaluate(request, ruleset, approved))) needsAsk = false

      // Destructive-action guard (see ./guard): only sessions or configs with a "destructive"
      // rule use it. A flagged call asks even when its tool is allowed, with a one-line reason.
      const guarded = yield* Guard.evaluate(request, ruleset, approved)
      if (guarded?.action === "deny") {
        return yield* new PermissionV1.DeniedError({ ruleset: ruleset.filter((rule) => rule.permission === Guard.ID) })
      }
      if (guarded?.action === "ask") needsAsk = true

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        // The proposed change rides along so clients can show it before approval, capped in size.
        metadata: {
          ...(request.permission === "edit" ? PermissionDiff.metadata(request.metadata) : request.metadata),
          ...(guarded?.action === "ask" ? { guard: guarded.reason } : {}),
        },
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const current = yield* InstanceState.get(state)
      const { approved, pending } = current
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }
      if (current.projectID !== "global" && !NOT_SAVED.has(existing.info.permission) && existing.info.always.length) {
        yield* store.add({
          projectID: current.projectID as never,
          action: existing.info.permission,
          resources: existing.info.always,
        })
        current.saved = yield* savedRules(current.projectID)
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        // 10-24 (audit C06): an "always" for one request never answers a request the guard flagged
        if (item.info.metadata?.guard) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const saved = Effect.fn("Permission.saved")(function* () {
      const current = yield* InstanceState.get(state)
      if (current.projectID === "global") return []
      const rows = yield* store.list({ projectID: current.projectID as never })
      return rows
        .filter((row) => !NOT_SAVED.has(row.action))
        .map((row): SavedRule => ({ id: row.id, permission: row.action, pattern: row.resource }))
    })

    const forget = Effect.fn("Permission.forget")(function* (id: string) {
      const current = yield* InstanceState.get(state)
      const rows = yield* store.list({ projectID: current.projectID as never })
      // only this project's rules
      if (!rows.some((row) => row.id === id)) return
      yield* store.remove(id as never)
      current.saved = yield* savedRules(current.projectID)
    })

    return Service.of({ ask, reply, list, saved, forget })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

// 10-28: an agent's rules followed by the session's (the TUI's manual/auto mode). Matching is last-wins, so auto mode's
// blanket allow used to lift an agent's own limits: the plan agent could edit any file. Every permission the agent
// denies gets all of its rules for that permission again after the session's, so the deny holds and so do its
// exceptions (the plan agent may still write its plan file). A deny the agent itself lifts with a later "*" rule (the
// build agent allows question) is not a limit and is left alone; so are the session's asks and allows everywhere else.
export function withSession(agent: PermissionV1.Ruleset, session: PermissionV1.Ruleset = []): PermissionV1.Rule[] {
  if (!session.length) return [...agent]
  const limited = new Set<string>()
  agent.forEach((rule, i) => {
    if (rule.action !== "deny") return
    const lifted = agent
      .slice(i + 1)
      .some((later) => later.permission === rule.permission && later.pattern === "*" && later.action !== "deny")
    if (!lifted) limited.add(rule.permission)
  })
  return [...agent, ...session, ...agent.filter((rule) => limited.has(rule.permission))]
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(PermissionSaved.defaultLayer),
)

const savedNode = LayerNode.make(PermissionSaved.layer, [Database.node])
export const node = LayerNode.make(layer, [EventV2Bridge.node, savedNode])

export * as Permission from "."
