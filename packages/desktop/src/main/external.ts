// Guards for the two IPC calls that reach outside the app: opening a link in the system browser
// and opening the project folder in another app. The renderer shows model output, so treat
// what it sends as untrusted. No electron import here, so the rules are unit-testable.

import { posix, win32 } from "node:path"

const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])

/** The URL to hand to shell.openExternal, or null when it is not a web or mail link. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length > 8192) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  return LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}

// The "Open in" apps the session header offers (packages/app session-header.tsx, `openWith`),
// per platform. Anything else from the renderer is refused rather than executed.
export const OPEN_WITH_APPS: Record<string, readonly string[]> = {
  darwin: [
    "Visual Studio Code",
    "Cursor",
    "Zed",
    "TextMate",
    "Antigravity",
    "Terminal",
    "iTerm",
    "Ghostty",
    "Warp",
    "Xcode",
    "Android Studio",
    "Sublime Text",
  ],
  win32: ["code", "cursor", "zed", "powershell", "Sublime Text"],
  linux: ["code", "cursor", "zed", "Sublime Text"],
}

export type OpenPlan =
  | { kind: "default" }
  | { kind: "exec"; cmd: string; args: string[] }
  | { kind: "refused"; reason: string }

/**
 * How to open `path` with `app`. Only absolute paths, and only apps from the allowlist; on
 * Windows the command is resolved here (`where`), never taken from the renderer.
 */
export async function planOpenPath(
  path: unknown,
  app: unknown,
  platform: string,
  resolveAppPath: (name: string) => Promise<string | null> | string | null,
): Promise<OpenPlan> {
  const isAbsolute = platform === "win32" ? win32.isAbsolute : posix.isAbsolute
  if (typeof path !== "string" || !isAbsolute(path)) return { kind: "refused", reason: "not an absolute path" }
  if (app === undefined || app === null || app === "") return { kind: "default" }
  if (typeof app !== "string" || !(OPEN_WITH_APPS[platform] ?? []).includes(app))
    return { kind: "refused", reason: "app not allowed" }
  if (platform === "darwin") return { kind: "exec", cmd: "open", args: ["-a", app, path] }
  if (platform === "win32") {
    const resolved = await Promise.resolve(resolveAppPath(app)).catch(() => null)
    // not installed: fall back to the default opener, as before
    if (!resolved) return { kind: "default" }
    return { kind: "exec", cmd: resolved, args: [path] }
  }
  return { kind: "exec", cmd: app, args: [path] }
}
