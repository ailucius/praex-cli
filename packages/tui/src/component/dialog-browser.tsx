// 10-28 (founder: "did you fix/improve this for real users"): Praex could only drive a browser when a user wrote an MCP
// entry by hand. /browser connects Playwright's MCP server in one step and keeps the choice in the global config.
// "Your Chrome" drives the user's own Chrome through the Playwright Extension (their logins and tabs; on first use
// Chrome asks which tab to share). "Separate window" opens a fresh Chrome that Playwright controls. Both run through
// npx, so they need Node.js. The server is named "playwright" (its tools read playwright_browser_navigate, and an entry
// by that name written by hand is replaced). Page snapshots and unnamed screenshots go to Praex's temp folder, which
// the agent may read without asking, instead of a .playwright-mcp folder in the user's project.
import path from "path"
import open from "open"
import { createResource } from "solid-js"
import type { McpLocalConfig } from "@opencode-ai/sdk/v2"
import { Global } from "@opencode-ai/core/global"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"

export const BROWSER_MCP = "playwright"
export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.83"
export const EXTENSION_URL =
  "https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm"

export type BrowserChoice = "chrome" | "window" | "off"

export function browserEntry(choice: BrowserChoice, outputDir = path.join(Global.Path.tmp, "browser")): McpLocalConfig {
  return {
    type: "local",
    command: ["npx", "-y", PLAYWRIGHT_MCP, "--output-dir", outputDir, ...(choice === "chrome" ? ["--extension"] : [])],
    enabled: choice !== "off",
    // the first start downloads the package
    timeout: 90_000,
  }
}

export function browserChoice(entry: unknown): BrowserChoice {
  if (!entry || typeof entry !== "object") return "off"
  const { enabled, command } = entry as { enabled?: unknown; command?: unknown }
  if (enabled === false) return "off"
  return Array.isArray(command) && command.includes("--extension") ? "chrome" : "window"
}

export function DialogBrowser() {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const [saved] = createResource(async () => {
    const result = await sdk.client.global.config.get().catch(() => undefined)
    return browserChoice(result?.data?.mcp?.[BROWSER_MCP])
  })

  async function choose(choice: BrowserChoice) {
    dialog.clear()
    const entry = browserEntry(choice)
    const stored = await sdk.client.global.config
      .update({ config: { mcp: { [BROWSER_MCP]: entry } } })
      .catch(() => ({ error: true }))
    if (stored && "error" in stored && stored.error) {
      toast.show({ variant: "error", message: "Could not save the browser setting to your Praex config.", duration: 6000 })
      return
    }
    if (choice === "off") {
      await sdk.client.mcp.disconnect({ name: BROWSER_MCP }).catch(() => {})
      await refresh()
      toast.show({ variant: "info", message: "Browser tools are off.", duration: 3000 })
      return
    }
    if (choice === "chrome") open(EXTENSION_URL).catch(() => {})
    toast.show({ variant: "info", message: "Starting the browser tools (the first time downloads them)...", duration: 4000 })
    await sdk.client.mcp.add({ name: BROWSER_MCP, config: entry }).catch(() => {})
    const status = await refresh()
    const state = status?.[BROWSER_MCP]
    if (state?.status !== "connected") {
      const detail = state && "error" in state && state.error ? ` (${state.error})` : ""
      toast.show({
        variant: "error",
        message: `The browser tools did not start${detail}. They need Node.js 18 or newer (nodejs.org).`,
        duration: 10000,
      })
      return
    }
    toast.show({
      variant: "success",
      message:
        choice === "chrome"
          ? "Browser connected. Add the Playwright Extension to Chrome (opened in your browser); the first time Praex uses it, Chrome asks which tab to share."
          : "Browser connected. Praex opens its own Chrome window when it needs one.",
      duration: 10000,
    })
  }

  async function refresh() {
    const status = await sdk.client.mcp.status().catch(() => undefined)
    if (status?.data) sync.set("mcp", status.data)
    return status?.data
  }

  return (
    <DialogSelect<BrowserChoice>
      title="Browser"
      flat={true}
      current={saved()}
      options={[
        {
          value: "chrome",
          title: "Your Chrome",
          description: "your logins, needs a Chrome extension",
          onSelect: () => void choose("chrome"),
        },
        {
          value: "window",
          title: "Separate window",
          description: "a fresh Chrome window, signed out",
          onSelect: () => void choose("window"),
        },
        {
          value: "off",
          title: "Off",
          description: "no browser tools",
          onSelect: () => void choose("off"),
        },
      ]}
    />
  )
}
