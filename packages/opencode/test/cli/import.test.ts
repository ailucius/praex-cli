import { test, expect } from "bun:test"
import { isLink, LINK_IMPORT_MESSAGE } from "../../src/cli/cmd/import"

// `praex import` reads files from `praex export`; links are refused, never fetched.
test("treats http(s) arguments as links", () => {
  expect(isLink("https://praex.ai/s/6bOREq8k40Y16AYN8OLeJI")).toBe(true)
  expect(isLink("https://opncd.ai/share/Jsj3hNIW")).toBe(true)
  expect(isLink("HTTP://example.com/x")).toBe(true)
})

test("treats paths as files", () => {
  expect(isLink("session.json")).toBe(false)
  expect(isLink("./exports/https-notes.json")).toBe(false)
  expect(isLink("/tmp/session.json")).toBe(false)
})

test("the refusal says what to do instead", () => {
  expect(LINK_IMPORT_MESSAGE).toContain("praex export")
  expect(LINK_IMPORT_MESSAGE).not.toMatch(/opencode|opncd/i)
})
