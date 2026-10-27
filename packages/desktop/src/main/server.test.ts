// 10-27 (audit9 R9-13): the startup health poll must stop on every way startup ends (child
// exit, the absolute deadline, stop(), success). It used to race an endless `while (true)` poll
// against the child's exit, and the losing loop kept fetching /global/health forever.
import { afterAll, describe, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exited = false
  postMessage(message: { type: string }) {
    if (message.type === "start") queueMicrotask(() => this.emit("message", { type: "ready" }))
    if (message.type === "stop") queueMicrotask(() => this.exit(0))
  }
  kill() {
    this.exit(1)
  }
  exit(code: number) {
    if (this.exited) return
    this.exited = true
    this.emit("exit", code)
  }
}

let child = new FakeChild()
const app = Object.assign(new EventEmitter(), { isPackaged: true, getPath: () => "/tmp" })
mock.module("electron", () => ({ app, utilityProcess: { fork: () => child } }))
mock.module("./logging", () => ({ getLogger: () => ({ log() {}, warn() {}, error() {} }) }))
mock.module("./store", () => ({ getStore: () => new Map() }))
const { spawnLocalServer } = await import("./server")

let requests = 0
let healthyAfter = Number.POSITIVE_INFINITY
let server: ReturnType<typeof Bun.serve> | undefined

// A fresh health endpoint per test, so a poll leaked by one test cannot be counted by another.
function serve() {
  server?.stop(true)
  requests = 0
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/global/health") return new Response("not found", { status: 404 })
      requests += 1
      const ok = requests >= healthyAfter
      return new Response(ok ? "ok" : "unhealthy", { status: ok ? 200 : 503 })
    },
  })
  return server.port!
}

afterAll(() => {
  server?.stop(true)
})

async function start(options: { healthTimeoutMs?: number } = {}) {
  child = new FakeChild()
  return spawnLocalServer("127.0.0.1", serve(), "secret", { userDataPath: "/tmp", ...options })
}

// Fails fast instead of hanging when health.wait never settles.
function settle<T>(promise: Promise<T>, ms = 3000) {
  return Promise.race([
    promise.then(
      () => "resolved",
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    ),
    Bun.sleep(ms).then(() => "pending"),
  ])
}

describe("desktop sidecar startup health (audit9 R9-13)", () => {
  test("polling stops when the sidecar exits before the health check passes", async () => {
    healthyAfter = Number.POSITIVE_INFINITY
    const { health } = await start()
    await Bun.sleep(250)
    expect(requests).toBeGreaterThan(0)
    child.exit(1)
    expect(await settle(health.wait)).toContain("exited before health check passed with code 1")
    const settled = requests
    await Bun.sleep(400)
    expect(requests).toBe(settled)
  })

  test("polling stops at the absolute health deadline", async () => {
    healthyAfter = Number.POSITIVE_INFINITY
    const { health, listener } = await start({ healthTimeoutMs: 300 })
    try {
      expect(await settle(health.wait)).toContain("did not pass within 300ms")
      const settled = requests
      await Bun.sleep(400)
      expect(requests).toBe(settled)
    } finally {
      await listener.stop()
    }
  })

  test("polling stops when the listener is stopped before the health check passes", async () => {
    healthyAfter = Number.POSITIVE_INFINITY
    const { health, listener } = await start()
    await Bun.sleep(150)
    await listener.stop()
    expect(await settle(health.wait)).toStartWith("rejected:")
    const settled = requests
    await Bun.sleep(400)
    expect(requests).toBe(settled)
  })

  test("a healthy sidecar resolves once and polling stops", async () => {
    healthyAfter = 2
    const { health, listener } = await start()
    try {
      expect(await settle(health.wait)).toBe("resolved")
      expect(requests).toBe(2)
      await Bun.sleep(300)
      expect(requests).toBe(2)
    } finally {
      await listener.stop()
    }
  })
})
