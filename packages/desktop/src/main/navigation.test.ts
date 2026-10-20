import { describe, expect, test } from "bun:test"
import { applyNavigationGuard, navigationDecision } from "./navigation"
import { isRendererUrl } from "./renderer-origin"

// 10-20: A14 regression. Windows stay on the renderer origin; links leave through the allowlist.

const isOwn = (url: string) => isRendererUrl(url, false, undefined)

const fakeContents = () => {
  const listeners: Record<string, (event: any, url: string) => void> = {}
  let openHandler: ((details: { url: string }) => { action: string }) | undefined
  return {
    listeners,
    open: (url: string) => openHandler!({ url }),
    on(name: string, fn: (event: any, url: string) => void) {
      listeners[name] = fn
    },
    setWindowOpenHandler(fn: (details: { url: string }) => any) {
      openHandler = fn
    },
  }
}

const navEvent = (url: string, isMainFrame = true) => {
  const e = { url, isMainFrame, prevented: false, preventDefault: () => (e.prevented = true) }
  return e
}

describe("navigation guard", () => {
  test("decision: own origin stays, web links leave, the rest is dropped", () => {
    expect(navigationDecision("oc://renderer/index.html#/session", isOwn)).toEqual({ allow: true })
    expect(navigationDecision("https://praex.ai/pricing", isOwn)).toEqual({
      allow: false,
      external: "https://praex.ai/pricing",
    })
    expect(navigationDecision("file:///etc/passwd", isOwn)).toEqual({ allow: false, external: null })
    expect(navigationDecision("javascript:alert(1)", isOwn)).toEqual({ allow: false, external: null })
  })

  test("off-origin navigation is prevented; a web link opens in the system browser", () => {
    const contents = fakeContents()
    const opened: string[] = []
    applyNavigationGuard(contents, { openExternal: (url) => opened.push(url), isOwn })

    const own = navEvent("oc://renderer/index.html")
    contents.listeners["will-navigate"](own, own.url)
    expect(own.prevented).toBe(false)

    const away = navEvent("https://evil.example/phish")
    contents.listeners["will-navigate"](away, away.url)
    expect(away.prevented).toBe(true)

    const file = navEvent("file:///C:/Windows/System32/calc.exe")
    contents.listeners["will-navigate"](file, file.url)
    expect(file.prevented).toBe(true)

    expect(opened).toEqual(["https://evil.example/phish"])
  })

  test("off-origin main-frame redirects are prevented and never opened outside", () => {
    const contents = fakeContents()
    const opened: string[] = []
    applyNavigationGuard(contents, { openExternal: (url) => opened.push(url), isOwn })

    const redirect = navEvent("https://evil.example/")
    contents.listeners["will-redirect"](redirect, redirect.url)
    expect(redirect.prevented).toBe(true)

    const sub = navEvent("https://www.youtube.com/embed/x", false)
    contents.listeners["will-redirect"](sub, sub.url)
    expect(sub.prevented).toBe(false)

    const own = navEvent("oc://renderer/index.html")
    contents.listeners["will-redirect"](own, own.url)
    expect(own.prevented).toBe(false)
    expect(opened).toEqual([])
  })

  test("window.open is always denied; allowed external URLs go to the opener", () => {
    const contents = fakeContents()
    const opened: string[] = []
    applyNavigationGuard(contents, { openExternal: (url) => opened.push(url), isOwn })

    expect(contents.open("https://praex.ai/download")).toEqual({ action: "deny" })
    expect(contents.open("mailto:davor@praex.ai")).toEqual({ action: "deny" })
    expect(contents.open("oc://renderer/index.html")).toEqual({ action: "deny" })
    expect(contents.open("file:///etc/passwd")).toEqual({ action: "deny" })
    expect(contents.open("smb://host/share")).toEqual({ action: "deny" })

    expect(opened).toEqual(["https://praex.ai/download", "mailto:davor@praex.ai"])
  })

  test("legacy positional url is honoured when the event has none", () => {
    const contents = fakeContents()
    applyNavigationGuard(contents, { openExternal: () => {}, isOwn })
    const e = { prevented: false, preventDefault: () => (e.prevented = true) }
    contents.listeners["will-navigate"](e, "https://evil.example/")
    expect(e.prevented).toBe(true)
  })
})
