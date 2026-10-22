import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"

// 10-22: "Allow always" is saved per project and survives a restart; /permissions lists and removes the
// saved rules; edits are not saved; the destructive-action guard still asks under a saved allow; read-only
// commands run without asking when a "readonly" allow rule is set (the TUI's manual mode).
const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(PermissionSaved.defaultLayer), Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
)
const it = testEffect(env)

const MANUAL: PermissionV1.Rule[] = [
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
  { permission: "destructive", pattern: "*", action: "ask" },
]

const pending = Effect.gen(function* () {
  const permission = yield* Permission.Service
  for (let i = 0; i < 100; i++) {
    const list = yield* permission.list()
    if (list.length) return list
    yield* Effect.sleep("10 millis")
  }
  return []
})

// Asks and reports whether it had to wait for a reply; replies with `answer` when it did.
const askAndAnswer = (input: Omit<PermissionV1.AskInput, "sessionID">, answer: "once" | "always" | "reject" = "reject") =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission.ask({ sessionID: SessionID.make("ses_saved"), ...input }).pipe(Effect.forkScoped)
    const waiting = yield* pending
    if (waiting.length) yield* permission.reply({ requestID: waiting[0]!.id, reply: answer })
    yield* Fiber.await(fiber)
    return waiting.length > 0
  })

const restart = Effect.gen(function* () {
  const test = yield* TestInstance
  const store = yield* InstanceStore.Service
  yield* store.dispose(yield* store.load({ directory: test.directory }))
})

it.instance(
  "allow always is saved for the project, survives a restart and can be removed",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const npm = { permission: "bash", patterns: ["npm test"], always: ["npm test *"], metadata: {}, ruleset: MANUAL }

      expect(yield* askAndAnswer(npm, "always")).toBe(true)
      yield* restart
      expect(yield* askAndAnswer(npm)).toBe(false)

      const saved = yield* permission.saved()
      expect(saved.map((rule) => [rule.permission, rule.pattern])).toEqual([["bash", "npm test *"]])

      yield* permission.forget(saved[0]!.id)
      expect(yield* permission.saved()).toEqual([])
      expect(yield* askAndAnswer(npm)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "edits allowed always last for this run only",
  () =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      const edit = { permission: "edit", patterns: ["src/a.ts"], always: ["*"], metadata: {}, ruleset: MANUAL }
      expect(yield* askAndAnswer(edit, "always")).toBe(true)
      expect(yield* askAndAnswer(edit)).toBe(false)
      expect(yield* permission.saved()).toEqual([])
      yield* restart
      expect(yield* askAndAnswer(edit)).toBe(true)
    }),
  { git: true },
)

it.instance(
  "the destructive-action guard still asks under a saved allow",
  () =>
    Effect.gen(function* () {
      yield* askAndAnswer(
        { permission: "bash", patterns: ["git push"], always: ["git push *"], metadata: { command: "git push" }, ruleset: MANUAL },
        "always",
      )
      yield* restart
      expect(
        yield* askAndAnswer({ permission: "bash", patterns: ["git push"], always: [], metadata: { command: "git push" }, ruleset: MANUAL }),
      ).toBe(false)
      expect(
        yield* askAndAnswer({
          permission: "bash",
          patterns: ["git push --force"],
          always: [],
          metadata: { command: "git push --force" },
          ruleset: MANUAL,
        }),
      ).toBe(true)
    }),
  { git: true },
)

it.instance(
  "read-only commands run without asking when the session turns it on",
  () =>
    Effect.gen(function* () {
      const readonly = [...MANUAL, { permission: "readonly", pattern: "*", action: "allow" as const }]
      const bash = (command: string, ruleset: PermissionV1.Rule[]) => ({
        permission: "bash",
        patterns: [command],
        always: [],
        metadata: { command },
        ruleset,
      })
      expect(yield* askAndAnswer(bash("ls -la", readonly))).toBe(false)
      expect(yield* askAndAnswer(bash("git status", readonly))).toBe(false)
      expect(yield* askAndAnswer(bash("cat x > y", readonly))).toBe(true)
      expect(yield* askAndAnswer(bash("ls; rm -rf x", readonly))).toBe(true)
      // without the rule nothing changes
      expect(yield* askAndAnswer(bash("ls -la", MANUAL))).toBe(true)
      // a deny still wins
      const denied = yield* Effect.exit(
        Effect.gen(function* () {
          const permission = yield* Permission.Service
          return yield* permission.ask({
            sessionID: SessionID.make("ses_saved"),
            ...bash("ls", [...readonly, { permission: "bash", pattern: "ls", action: "deny" }]),
          })
        }),
      )
      expect(Exit.isFailure(denied)).toBe(true)
    }),
  { git: true },
)
