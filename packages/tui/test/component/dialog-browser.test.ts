// 10-28: /browser writes one MCP entry to the global config; these check the entry and reading the choice back.
import { expect, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { BROWSER_MCP, browserChoice, browserEntry, PLAYWRIGHT_MCP } from "../../src/component/dialog-browser"

test("each choice writes a pinned Playwright MCP entry", () => {
  const out = path.join(Global.Path.tmp, "browser")
  expect(browserEntry("chrome")).toEqual({
    type: "local",
    command: ["npx", "-y", PLAYWRIGHT_MCP, "--output-dir", out, "--extension"],
    enabled: true,
    timeout: 90_000,
  })
  expect(browserEntry("window").command).toEqual(["npx", "-y", PLAYWRIGHT_MCP, "--output-dir", out])
  // tool names read playwright_browser_navigate, not browser_browser_navigate
  expect(BROWSER_MCP).toBe("playwright")
  expect(browserEntry("off").enabled).toBe(false)
  expect(PLAYWRIGHT_MCP).toMatch(/^@playwright\/mcp@\d+\.\d+\.\d+$/)
})

test("the saved entry reads back as the same choice", () => {
  for (const choice of ["chrome", "window", "off"] as const) expect(browserChoice(browserEntry(choice))).toBe(choice)
  expect(browserChoice(undefined)).toBe("off")
  // an entry written by hand without "enabled" is on
  expect(browserChoice({ type: "local", command: ["npx", "@playwright/mcp@latest", "--extension"] })).toBe("chrome")
})
