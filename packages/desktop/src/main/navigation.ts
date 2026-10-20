// 10-20: A14. Keeps every window on our own renderer. A main-frame navigation or redirect to any
// other origin is cancelled; window.open never creates an Electron window (a child window would
// inherit our preload). Web and mail links the renderer tries to open either way go to the
// system browser through the same allowlist as the open-link IPC (external.ts).
// Only type imports from electron, so the rules are unit-testable under bun test.

import type { WindowOpenHandlerResponse } from "electron"
import { safeExternalUrl } from "./external"
import { isRendererUrl } from "./renderer-origin"

export type NavigationDecision = { allow: true } | { allow: false; external: string | null }

/** Same-origin renderer pages may load in place; anything else is refused (and maybe opened outside). */
export function navigationDecision(url: string, isOwn: (url: string) => boolean = (u) => isRendererUrl(u)) {
  if (isOwn(url)) return { allow: true } as NavigationDecision
  return { allow: false, external: safeExternalUrl(url) } as NavigationDecision
}

type GuardEvent = { preventDefault(): void; url?: string; isMainFrame?: boolean }

type GuardedContents = {
  on(event: "will-navigate", listener: (event: any, url: string) => void): unknown
  on(event: "will-redirect", listener: (event: any, url: string) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResponse): void
}

type GuardOptions = {
  openExternal: (url: string) => unknown
  isOwn?: (url: string) => boolean
  log?: (message: string, data: Record<string, unknown>) => void
}

/** Install the navigation and window-open rules on one webContents. */
export function applyNavigationGuard(contents: GuardedContents, options: GuardOptions) {
  const isOwn = options.isOwn ?? ((url: string) => isRendererUrl(url))
  const log = options.log ?? (() => {})

  contents.on("will-navigate", (event: GuardEvent, legacyUrl?: string) => {
    const url = event.url ?? legacyUrl ?? ""
    const decision = navigationDecision(url, isOwn)
    if (decision.allow) return
    event.preventDefault()
    log("blocked navigation", { url, external: decision.external !== null })
    if (decision.external) void options.openExternal(decision.external)
  })

  // A redirect is the server's choice, not a click: block it off-origin, never open it outside.
  contents.on("will-redirect", (event: GuardEvent, legacyUrl?: string) => {
    if (event.isMainFrame === false) return
    const url = event.url ?? legacyUrl ?? ""
    if (isOwn(url)) return
    event.preventDefault()
    log("blocked redirect", { url })
  })

  contents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url)
    log("window open", { url, external: external !== null })
    if (external) void options.openExternal(external)
    return { action: "deny" }
  })
}
