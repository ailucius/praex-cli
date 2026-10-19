import { afterEach, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"

const original = {
  OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
}

afterEach(() => {
  Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
  Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
})

describe("ServerAuth", () => {
  test("does not emit auth headers without a password", () => {
    Flag.OPENCODE_SERVER_PASSWORD = undefined
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.header()).toBeUndefined()
    expect(ServerAuth.headers()).toBeUndefined()
  })

  test("clients send the legacy opencode username by default (older servers expect it)", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = undefined

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  test("uses the configured username", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers()).toEqual({
      Authorization: `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    })
  })

  test("prefers explicit credentials", () => {
    Flag.OPENCODE_SERVER_PASSWORD = "secret"
    Flag.OPENCODE_SERVER_USERNAME = "alice"

    expect(ServerAuth.headers({ password: "cli-secret", username: "bob" })).toEqual({
      Authorization: `Basic ${Buffer.from("bob:cli-secret").toString("base64")}`,
    })
  })

  test("validates decoded credentials against effect config", () => {
    const config = { password: Option.some("secret"), username: "alice" }

    expect(ServerAuth.required(config)).toBe(true)
    expect(ServerAuth.authorized({ username: "alice", password: Redacted.make("secret") }, config)).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(false)
  })

  test("the default server user is praex, and the legacy opencode name still signs in", () => {
    const config = { password: Option.some("secret"), username: ServerAuth.DEFAULT_USERNAME }
    const ok = (username: string, password = "secret") =>
      ServerAuth.authorized({ username, password: Redacted.make(password) }, config)
    expect(ok("praex")).toBe(true)
    expect(ok("opencode")).toBe(true)
    expect(ok("praex", "wrong")).toBe(false)
    expect(ok("someone")).toBe(false)
  })

  test("an explicitly configured username accepts only that name", () => {
    const config = { password: Option.some("secret"), username: "alice" }
    const ok = (username: string) => ServerAuth.authorized({ username, password: Redacted.make("secret") }, config)
    expect(ok("alice")).toBe(true)
    expect(ok("opencode")).toBe(false)
    expect(ok("praex")).toBe(false)
  })
})
