import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { guardIpc, ipcSenderProblem, trustWebContents, type IpcEventLike, type SenderGate } from "./ipc-trust"
import { isRendererUrl, rendererPageUrl } from "./renderer-origin"

// 10-20: A14 regression. The sender gate in front of every IPC channel.

const ours = 7
const gate: SenderGate = {
  isTrustedContents: (id) => id === ours,
  isRendererUrl: (url) => isRendererUrl(url, false, undefined),
}
const mainFrame = { url: "oc://renderer/index.html", parent: null, processId: 3, routingId: 1 }
const event = (patch: Partial<IpcEventLike> = {}): IpcEventLike => ({
  sender: { id: ours, mainFrame },
  senderFrame: mainFrame,
  ...patch,
})

describe("ipc sender gate", () => {
  test("our window's main frame on the renderer origin is served", () => {
    expect(ipcSenderProblem(event(), gate)).toBeNull()
    // Electron may hand back a different wrapper for the same frame: same process and routing id
    const sameFrame = { ...mainFrame }
    expect(ipcSenderProblem(event({ senderFrame: sameFrame }), gate)).toBeNull()
  })

  test("a subframe is refused, even one on our own origin", () => {
    const sub = { url: "oc://renderer/index.html", parent: mainFrame, processId: 3, routingId: 9 }
    expect(ipcSenderProblem(event({ senderFrame: sub }), gate)).toBe("not the main frame")
    const detached = { url: "oc://renderer/index.html", parent: null, processId: 3, routingId: 9 }
    expect(ipcSenderProblem(event({ senderFrame: detached }), gate)).toBe("not the main frame")
  })

  test("a foreign origin is refused", () => {
    for (const url of [
      "https://evil.example/index.html",
      "file:///tmp/index.html",
      "oc://elsewhere/index.html",
      "http://localhost:5173/index.html",
      "about:blank",
      "",
    ]) {
      const frame = { ...mainFrame, url }
      expect(ipcSenderProblem(event({ sender: { id: ours, mainFrame: frame }, senderFrame: frame }), gate)).toBe(
        "untrusted origin",
      )
    }
  })

  test("the dev server origin is trusted only while electron-vite runs one", () => {
    const dev: SenderGate = { ...gate, isRendererUrl: (url) => isRendererUrl(url, false, "http://localhost:5173/") }
    const frame = { ...mainFrame, url: "http://localhost:5173/index.html" }
    expect(ipcSenderProblem(event({ sender: { id: ours, mainFrame: frame }, senderFrame: frame }), dev)).toBeNull()
    const other = { ...mainFrame, url: "http://localhost:5174/index.html" }
    expect(ipcSenderProblem(event({ sender: { id: ours, mainFrame: other }, senderFrame: other }), dev)).toBe(
      "untrusted origin",
    )
    expect(rendererPageUrl("index.html", "http://localhost:5173/")).toBe("http://localhost:5173/index.html")
    expect(rendererPageUrl("index.html", undefined)).toBe("oc://renderer/index.html")
  })

  test("an unknown webContents is refused", () => {
    expect(ipcSenderProblem(event({ sender: { id: 99, mainFrame } }), gate)).toBe("unknown webContents")
  })

  test("a frame that is gone is refused", () => {
    expect(ipcSenderProblem(event({ senderFrame: null }), gate)).toBe("no sender frame")
  })

  test("trustWebContents registers a window until it is destroyed", () => {
    const listeners: Record<string, () => void> = {}
    const contents = { id: 4242, once: (name: "destroyed", fn: () => void) => (listeners[name] = fn) }
    const frame = { ...mainFrame }
    const e = { sender: { id: 4242, mainFrame: frame }, senderFrame: frame }
    expect(ipcSenderProblem(e)).toBe("unknown webContents")
    trustWebContents(contents)
    expect(ipcSenderProblem(e)).toBeNull()
    listeners.destroyed()
    expect(ipcSenderProblem(e)).toBe("unknown webContents")
  })
})

describe("guardIpc", () => {
  const fakeIpc = () => {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    return {
      handlers,
      handle: (channel: string, fn: (...args: any[]) => unknown) => void handlers.set(channel, fn),
      on: (channel: string, fn: (...args: any[]) => unknown) => void handlers.set(channel, fn),
    }
  }

  test("handle: untrusted invoke is rejected before the listener runs", () => {
    const ipc = fakeIpc()
    const logs: unknown[] = []
    let ran = 0
    guardIpc(ipc as any, (message, data) => logs.push({ message, data }), gate).handle(
      "store-get",
      (_event, name: string) => {
        ran++
        return name
      },
    )
    const fn = ipc.handlers.get("store-get")!
    expect(fn(event(), "default.dat")).toBe("default.dat")
    expect(ran).toBe(1)
    expect(() => fn(event({ sender: { id: 99, mainFrame } }), "default.dat")).toThrow("did not come from")
    const sub = { ...mainFrame, parent: mainFrame }
    expect(() => fn(event({ senderFrame: sub }), "default.dat")).toThrow("did not come from")
    expect(ran).toBe(1)
    expect(logs).toHaveLength(2)
  })

  test("on: untrusted message is dropped", () => {
    const ipc = fakeIpc()
    const seen: string[] = []
    guardIpc(ipc as any, () => {}, gate).on("open-link", (_event, url: string) => void seen.push(url))
    const fn = ipc.handlers.get("open-link")!
    fn(event(), "https://praex.ai")
    const foreign = { ...mainFrame, url: "https://evil.example/" }
    fn(event({ sender: { id: ours, mainFrame: foreign }, senderFrame: foreign }), "https://evil.example/x")
    expect(seen).toEqual(["https://praex.ai"])
  })

  test("no IPC channel is registered around the gate", () => {
    // every ipcMain.handle/on in the main process must go through guardIpc
    const root = import.meta.dir
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path)
      }
    }
    walk(root)
    const raw = files.filter(
      (file) =>
        !file.endsWith("ipc-trust.ts") &&
        /ipcMain\.(handle|handleOnce|on|once|addListener)\(/.test(readFileSync(file, "utf8")),
    )
    expect(raw).toEqual([])
  })
})
