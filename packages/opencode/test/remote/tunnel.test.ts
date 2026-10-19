import { afterEach, describe, expect, test } from "bun:test"
import { RemoteTunnel, SignedOutError, type RemoteStatus } from "../../src/remote/tunnel"
import { fakePhoneVerifier, uidOf } from "../../src/remote/verify"
import { relayConfig } from "../../src/remote"

// A stub relay: accepts /v1/agent sockets, records frames, lets the test push frames.
function stubRelay() {
  const sockets: any[] = []
  const frames: any[] = []
  const waiters: Array<{ match: (f: any) => boolean; resolve: (f: any) => void }> = []
  const auths: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url)
      auths.push(req.headers.get("authorization") ?? "")
      if (srv.upgrade(req, { data: { key: url.searchParams.get("key") } } as any)) return undefined
      return new Response("no", { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
        ws.send(JSON.stringify({ t: "welcome", key: (ws.data as any).key }))
      },
      message(ws, msg) {
        const f = { ...JSON.parse(String(msg)), _ws: ws }
        const i = waiters.findIndex((w) => w.match(f))
        if (i >= 0) waiters.splice(i, 1)[0].resolve(f)
        else frames.push(f)
      },
      close(ws) {
        const i = sockets.indexOf(ws)
        if (i >= 0) sockets.splice(i, 1)
      },
    },
  })
  const next = (match: (f: any) => boolean, ms = 3000) => {
    const i = frames.findIndex(match)
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0])
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms)
      waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) })
    })
  }
  return { url: `http://127.0.0.1:${server.port}`, sockets, frames, next, auths, stop: () => server.stop(true) }
}

async function collect(relay: ReturnType<typeof stubRelay>, id: string) {
  const head = await relay.next((f) => f.id === id && (f.t === "res" || f.t === "error"))
  let body = ""
  if (head.t === "res") {
    for (;;) {
      const f = await relay.next((x) => x.id === id && (x.t === "data" || x.t === "end" || x.t === "error"))
      if (f.t !== "data") break
      body += Buffer.from(f.data, "base64").toString()
    }
  }
  return { status: head.status, headers: head.headers, body }
}

let relay: ReturnType<typeof stubRelay> | undefined
let tunnel: RemoteTunnel | undefined
afterEach(() => {
  tunnel?.stop()
  relay?.stop()
  tunnel = relay = undefined
})

function make(opts: Partial<ConstructorParameters<typeof RemoteTunnel>[0]> = {}) {
  relay = stubRelay()
  const statuses: RemoteStatus[] = []
  const seen: Request[] = []
  tunnel = new RemoteTunnel({
    relayUrl: relay.url,
    link: "praex.ai/rc",
    dispatch: async (req) => {
      seen.push(req)
      const body = req.method === "POST" ? await req.text() : ""
      return Response.json({ path: new URL(req.url).pathname + new URL(req.url).search, method: req.method, body })
    },
    credential: async () => ({ token: "test:alice", uid: "alice" }),
    verifyPhone: fakePhoneVerifier,
    meta: () => ({ name: "laptop", directory: "praex-cli", title: "Fix the build" }),
    onStatus: (s) => statuses.push(s),
    ...opts,
  })
  return { relay, tunnel, statuses, seen }
}

describe("RemoteTunnel", () => {
  test("connects out with the user's token and says hello", async () => {
    const { relay, tunnel, statuses } = make()
    await tunnel.start()
    const hello = await relay.next((f) => f.t === "hello")
    expect(hello).toMatchObject({ name: "laptop", directory: "praex-cli", title: "Fix the build" })
    expect(relay.auths[0]).toBe("Bearer test:alice")
    expect(statuses.at(-1)).toMatchObject({ state: "on", link: "praex.ai/rc", key: tunnel.key })
    expect(tunnel.key.length).toBeGreaterThanOrEqual(22)
  })

  test("grants only to a phone token for the same uid", async () => {
    const { relay, tunnel } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    ws.send(JSON.stringify({ t: "attach", id: "a1", idToken: "test:bob" }))
    expect((await relay.next((f) => f.id === "a1")).t).toBe("denied")
    ws.send(JSON.stringify({ t: "attach", id: "a2", idToken: "test:alice" }))
    const ok = await relay.next((f) => f.id === "a2")
    expect(ok.t).toBe("attached")
    expect(ok.grant.length).toBeGreaterThanOrEqual(40)
  })

  test("serves requests with a valid grant or same-uid token, refuses the rest", async () => {
    const { relay, tunnel, seen } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    ws.send(JSON.stringify({ t: "attach", id: "a", idToken: "test:alice" }))
    const { grant } = await relay.next((f) => f.id === "a")

    const body = Buffer.from('{"text":"hi"}').toString("base64")
    ws.send(JSON.stringify({ t: "req", id: "r1", method: "POST", path: "/session/x/message?directory=%2Ftmp", headers: { "content-type": "application/json" }, body, auth: { grant } }))
    const r1 = await collect(relay, "r1")
    expect(r1.status).toBe(200)
    expect(JSON.parse(r1.body)).toEqual({ path: "/session/x/message?directory=%2Ftmp", method: "POST", body: '{"text":"hi"}' })
    expect(seen[0].headers.get("content-type")).toBe("application/json")

    ws.send(JSON.stringify({ t: "req", id: "r2", method: "GET", path: "/session", headers: {}, auth: { grant: "forged".padEnd(43, "x") } }))
    expect((await collect(relay, "r2")).status).toBe(401)
    ws.send(JSON.stringify({ t: "req", id: "r3", method: "GET", path: "/session", headers: {}, auth: { idToken: "test:bob" } }))
    expect((await collect(relay, "r3")).status).toBe(401)
    ws.send(JSON.stringify({ t: "req", id: "r4", method: "GET", path: "/session", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "r4")).status).toBe(200)
    ws.send(JSON.stringify({ t: "req", id: "r5", method: "GET", path: "/session", headers: {} }))
    expect((await collect(relay, "r5")).status).toBe(401)
  })

  test("terminal endpoints and odd paths are refused", async () => {
    const { relay, tunnel } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    ws.send(JSON.stringify({ t: "req", id: "p1", method: "POST", path: "/pty", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "p1")).status).toBe(403)
    ws.send(JSON.stringify({ t: "req", id: "p2", method: "GET", path: "//evil.example/x", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "p2")).status).toBe(400)
  })

  test("streams a long response and stops it on cancel", async () => {
    let cancelled = false
    const { relay, tunnel } = make({
      dispatch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: one\n\n"))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    await tunnel.start()
    const ws = relay.sockets[0]
    ws.send(JSON.stringify({ t: "req", id: "s1", method: "GET", path: "/global/event", headers: {}, auth: { idToken: "test:alice" } }))
    const head = await relay.next((f) => f.id === "s1" && f.t === "res")
    expect(head.headers["content-type"]).toBe("text/event-stream")
    const chunk = await relay.next((f) => f.id === "s1" && f.t === "data")
    expect(Buffer.from(chunk.data, "base64").toString()).toBe("data: one\n\n")
    ws.send(JSON.stringify({ t: "cancel", id: "s1" }))
    await Bun.sleep(50)
    expect(cancelled).toBe(true)
  })

  test("reconnects with the same key when the relay drops the socket", async () => {
    const { relay, tunnel, statuses } = make()
    await tunnel.start()
    const key = tunnel.key
    await relay.next((f) => f.t === "hello")
    relay.sockets[0].close(1011, "gone")
    const second = await relay.next((f) => f.t === "hello", 5000)
    expect(second).toBeTruthy()
    expect(statuses.some((s) => s.state === "reconnecting")).toBe(true)
    expect(statuses.at(-1)).toMatchObject({ state: "on", key })
  })

  test("rotates make-before-break and closes the old socket", async () => {
    const { relay, tunnel } = make({ rotateMs: 150, drainMs: 2000 })
    await tunnel.start()
    await relay.next((f) => f.t === "hello")
    const second = await relay.next((f) => f.t === "hello", 3000)
    expect(second).toBeTruthy()
    await Bun.sleep(100)
    // the old socket had nothing in flight, so it closed right away; one socket remains
    expect(relay.sockets.length).toBe(1)
    expect(tunnel.current.state).toBe("on")
  })

  test("pushes a refreshed token", async () => {
    let n = 0
    const { relay, tunnel } = make({
      credential: async () => ({ token: n++ < 2 ? "test:alice" : "test:alice2", uid: "alice" }),
      tokenCheckMs: 50,
    })
    await tunnel.start()
    const f = await relay.next((x) => x.t === "token", 2000)
    expect(f.token).toBe("test:alice2")
  })

  test("signed out: start fails with a plain sentence", async () => {
    const { tunnel } = make({
      credential: async () => {
        throw new SignedOutError()
      },
    })
    await expect(tunnel.start()).rejects.toThrow("praex login")
  })

  test("stop turns everything off and forgets grants", async () => {
    const { relay, tunnel, statuses } = make()
    await tunnel.start()
    tunnel.stop()
    await Bun.sleep(50)
    expect(relay.sockets.length).toBe(0)
    expect(statuses.at(-1)).toEqual({ state: "off" })
  })
})

// Accepts the agent socket but never sends welcome (a hung relay or a proxy that swallows frames).
function silentRelay() {
  let opened = 0
  let closed = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (srv.upgrade(req, { data: {} } as any)) return undefined
      return new Response("no", { status: 400 })
    },
    websocket: {
      open() {
        opened++
      },
      message() {},
      close() {
        closed++
      },
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    opened: () => opened,
    closed: () => closed,
    stop: () => server.stop(true),
  }
}

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(10)
  }
}

describe("RemoteTunnel handshake deadline", () => {
  let silent: ReturnType<typeof silentRelay> | undefined
  let t: RemoteTunnel | undefined
  afterEach(() => {
    t?.stop()
    silent?.stop()
    t = silent = undefined
  })

  function makeSilent(opts: Partial<ConstructorParameters<typeof RemoteTunnel>[0]> = {}) {
    silent = silentRelay()
    const statuses: RemoteStatus[] = []
    const logs: string[] = []
    t = new RemoteTunnel({
      relayUrl: silent.url,
      link: "praex.ai/rc",
      dispatch: async () => new Response("unused"),
      credential: async () => ({ token: "test:alice", uid: "alice" }),
      verifyPhone: fakePhoneVerifier,
      meta: () => ({ name: "laptop", directory: "praex-cli" }),
      onStatus: (s) => statuses.push(s),
      log: (line) => logs.push(line),
      ...opts,
    })
    return { silent, tunnel: t, statuses, logs }
  }

  test("a relay that never welcomes is closed at the deadline and goes to the retry path", async () => {
    const { silent, tunnel, statuses, logs } = makeSilent({ welcomeMs: 200 })
    const started = Date.now()
    await tunnel.start()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(logs.some((l) => l.includes("first connect failed") && l.includes("no welcome"))).toBe(true)
    expect(statuses.at(-1)).toMatchObject({ state: "reconnecting", key: tunnel.key })
    await until(() => silent.closed() >= 1)
    // the retry opens a fresh socket, which hits the same deadline and is closed too
    await until(() => silent.opened() >= 2)
    await until(() => silent.closed() >= 2)
  })

  test("stop() cancels a handshake still waiting for welcome", async () => {
    const { silent, tunnel, statuses } = makeSilent()
    const starting = tunnel.start()
    await until(() => silent.opened() === 1)
    const stopped = Date.now()
    tunnel.stop()
    await starting
    expect(Date.now() - stopped).toBeLessThan(1000)
    await until(() => silent.closed() === 1)
    expect(statuses.at(-1)).toEqual({ state: "off" })
    // no retry is scheduled after stop (the first retry would fire after 250 ms)
    await Bun.sleep(400)
    expect(silent.opened()).toBe(1)
    expect(statuses.at(-1)).toEqual({ state: "off" })
  })
})

describe("config and tokens", () => {
  test("relay must be https unless it is on this machine; fake auth only on loopback", () => {
    expect(relayConfig({}).url).toStartWith("https://")
    expect(() => relayConfig({ PRAEX_RELAY_URL: "http://relay.example" })).toThrow()
    expect(relayConfig({ PRAEX_RELAY_URL: "http://127.0.0.1:9000", PRAEX_RC_FAKE_AUTH: "1" }).fake).toBe(true)
    expect(relayConfig({ PRAEX_RELAY_URL: "https://relay.example", PRAEX_RC_FAKE_AUTH: "1" }).fake).toBe(false)
  })
  test("uidOf reads user_id from a JWT payload", () => {
    const p = Buffer.from(JSON.stringify({ user_id: "u9", sub: "u9" })).toString("base64url")
    expect(uidOf(`x.${p}.y`)).toBe("u9")
    expect(uidOf("test:alice", true)).toBe("alice")
    expect(uidOf("test:alice")).toBeUndefined()
  })
})
