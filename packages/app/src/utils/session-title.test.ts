import { describe, expect, test } from "bun:test"
import { sessionTitle } from "./session-title"

describe("sessionTitle", () => {
  test("placeholder titles read as their kind", () => {
    expect(sessionTitle("New session - 2026-10-19T11:56:51.738Z")).toBe("New session")
  })
  test("markdown from the title model never shows", () => {
    expect(sessionTitle("### `let` vs `const` in JavaScript")).toBe("let vs const in JavaScript")
    expect(sessionTitle("**Shopping list**")).toBe("Shopping list")
    expect(sessionTitle('"Casual greeting"')).toBe("Casual greeting")
  })
  test("plain titles are untouched", () => {
    expect(sessionTitle("Fix the C# build")).toBe("Fix the C# build")
    expect(sessionTitle("Light chat")).toBe("Light chat")
  })
})
