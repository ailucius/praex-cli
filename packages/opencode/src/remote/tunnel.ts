// Praex Remote Control, computer side: one OUTBOUND WebSocket to the Praex relay. The relay
// forwards HTTP requests from the user's phone or browser down this socket; they are served
// by the in-process Praex server (no TCP listener is opened, on the LAN or on localhost) and
// the responses, including the SSE event stream, stream back up.
//
// Every forwarded request must carry either a grant this process minted (after checking the
// phone's Google-signed ID token itself) or such an ID token, for this same uid. A relay
// alone cannot drive this machine. Grants expire (12 hours by default, PRAEX_RC_GRANT_HOURS), after
// which the phone has to attach again with a fresh ID token, and all of them die with stop().
//
// Cloud Run ends WebSockets at its request timeout (60 min), so the socket is rotated
// make-before-break: a new one registers the same session key, the old one drains.

import { randomBytes, timingSafeEqual } from "node:crypto"
import type { PhoneVerifier } from "./verify"

export type RemoteStatus =
  | { state: "off" }
  | { state: "connecting" | "on" | "reconnecting"; link: string; key: string }
  | { state: "error"; message: string }

export class SignedOutError extends Error {
  constructor(message = "Remote Control needs a Praex account. Run praex login, then /rc again.") {
    super(message)
  }
}

export type Credential = { token: string; uid: string }

export type TunnelOptions = {
  relayUrl: string
  link: string
  dispatch: (req: Request) => Promise<Response>
  /** Current ID token (refreshed when close to expiry). Throws SignedOutError when signed out. */
  credential: (opts?: { force?: boolean }) => Promise<Credential>
  verifyPhone: PhoneVerifier
  meta: () => { name: string; directory: string; title?: string; version?: string; path?: string }
  onStatus: (s: RemoteStatus) => void
  rotateMs?: number
  drainMs?: number
  tokenCheckMs?: number
  /** How long the relay has to send its welcome frame after the socket opens. */
  welcomeMs?: number
  /** How long a phone's grant stays valid before it must attach again with a fresh ID token. */
  grantTtlMs?: number
  now?: () => number
  WebSocketImpl?: typeof WebSocket
  log?: (line: string) => void
}

type Frame = { t: string; [k: string]: any }
type Conn = {
  ws: WebSocket
  active: Map<string, { abort: () => void }>
  draining: boolean
  welcomed: boolean
  rotateTimer?: ReturnType<typeof setTimeout>
  drainTimer?: ReturnType<typeof setTimeout>
  welcomeTimer?: ReturnType<typeof setTimeout>
  /** Before welcome: close the socket and reject the pending open(). */
  abandon?: (error: Error) => void
}

const CHUNK = 64 * 1024
const WELCOME_MS = 15_000
const MAX_GRANTS = 32
export const GRANT_TTL_MS = 12 * 60 * 60 * 1000
export const GRANT_EXPIRED = "Remote Control approval expired. Open the page again to reconnect."

/** PRAEX_RC_GRANT_HOURS, when set to a positive number, else 12 hours. */
export function grantTtlFromEnv(env: Record<string, string | undefined> = process.env) {
  const hours = Number(env.PRAEX_RC_GRANT_HOURS)
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : GRANT_TTL_MS
}

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const ORIGIN = "http://opencode.internal"
// Paths a remote may not reach: terminals (the legacy /pty routes and the /api/pty surface,
// whose create call takes a command line) and the one-off shell command on a session. A raw
// shell from a phone is a bigger door than this feature needs; the agent's own tools (with
// their permission prompts) still run.
const BLOCKED = [/^\/(api\/)?pty(\/|$)/i, /^\/(api\/)?session\/[^/]+\/shell(\/|$)/i]
// 10-20: config writes are refused over Remote Control too. Config can name commands this
// machine will run (local MCP servers, formatters, LSP servers, provider npm packages), so a
// phone that can write it can run anything here. Reading stays open (the phone shows the model
// and agent from GET /config). Any method other than a read counts as a write, so an odd verb
// can not slip past a PATCH/PUT/POST list. Covers /config, /global/config, the /api surface,
// and POST /mcp, which adds an MCP server whose config may be a local command line.
// Connecting or disconnecting an MCP server the user already configured stays allowed (the
// phone's toggle); it starts nothing the user did not set up on this machine.
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])
const NO_WRITE = [/^\/(api\/)?(global\/)?config(\/|$)/i, /^\/(api\/)?mcp\/?$/i]
// 10-20: routes the phone uses for ordinary things whose body can also carry a command, so the
// body is read instead of refusing the route: project edit (name and icon are fine, a startup
// script in commands.start is not), worktree create (a startCommand runs in a shell), and
// provider auth (a "wellknown" entry makes this machine load that server's remote config,
// which can add local MCP commands; API keys and OAuth tokens are fine).
type BodyRule = { re: RegExp; refuse: (body: any, method: string) => boolean }
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== ""
const BODY_RULES: BodyRule[] = [
  { re: /^\/(api\/)?project\/[^/]+\/?$/i, refuse: (b) => !!b?.commands && Object.values(b.commands).some(nonEmpty) },
  { re: /^\/(api\/)?experimental\/worktree\/?$/i, refuse: (b) => nonEmpty(b?.startCommand) },
  // removing a credential (DELETE) carries no body and runs nothing
  { re: /^\/(api\/)?auth\/[^/]+\/?$/i, refuse: (b, m) => m !== "DELETE" && b?.type !== "api" && b?.type !== "oauth" },
]

export type PathCheck = { ok: true; url: string } | { ok: false; status: 400 | 403; message: string }

const CONFIG_REFUSED = "Settings that can run commands can only be changed on the computer, not over Remote Control."

function parseBody(body: Uint8Array | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!body || body.byteLength === 0) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) }
  } catch {
    return { ok: false }
  }
}

/**
 * The one gate for every request a remote makes. The path is normalised the way the request
 * URL will be (dot segments, %2e, backslashes), then tested as normalised and as percent-decoded
 * (a router may decode before matching), with repeated slashes folded. The URL handed back is
 * the one that was checked, so the check and the dispatch can not disagree. `method` must be
 * the one the request is dispatched with (upper case), and `body` the exact bytes sent on.
 */
export function checkRemotePath(path: unknown, method = "GET", body?: Uint8Array): PathCheck {
  const bad = { ok: false, status: 400, message: "Bad path." } as const
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return bad
  let url: URL
  try {
    url = new URL(path, ORIGIN)
  } catch {
    return bad
  }
  if (url.origin !== ORIGIN) return bad
  const write = !READ_METHODS.has(method)
  let parsed: ReturnType<typeof parseBody> | undefined
  let pathname = url.pathname
  for (let round = 0; round < 4; round++) {
    const flat = pathname.replace(/\/{2,}/g, "/")
    if (BLOCKED.some((re) => re.test(flat)))
      return { ok: false, status: 403, message: "The terminal and shell are not available over Remote Control." }
    if (write && NO_WRITE.some((re) => re.test(flat))) return { ok: false, status: 403, message: CONFIG_REFUSED }
    if (write) {
      for (const rule of BODY_RULES) {
        if (!rule.re.test(flat)) continue
        parsed ??= parseBody(body)
        if (!parsed.ok) return { ok: false, status: 400, message: "Bad request body." }
        if (rule.refuse(parsed.value, method)) return { ok: false, status: 403, message: CONFIG_REFUSED }
      }
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      // malformed escapes in the request itself are refused; a literal "%" that only shows up
      // after one decode (a file named "100%") can not decode further, so the check is done
      if (round === 0) return bad
      return { ok: true, url: url.href }
    }
    if (decoded === pathname) return { ok: true, url: url.href }
    try {
      pathname = new URL(ORIGIN + decoded).pathname
    } catch {
      return bad
    }
  }
  // still decoding after several rounds: nothing legitimate is encoded that deep
  return bad
}

export const randomKey = (bytes = 16) => randomBytes(bytes).toString("base64url")

export class RemoteTunnel {
  readonly key = randomKey()
  private conns = new Set<Conn>()
  // Sockets still waiting for the relay's welcome; tracked from creation so stop() can cancel them.
  private pending = new Set<Conn>()
  private grants: { grant: string; exp: number }[] = []
  private stopped = false
  private uid = ""
  private lastToken = ""
  private status: RemoteStatus = { state: "off" }
  private retry?: ReturnType<typeof setTimeout>
  private tokenTimer?: ReturnType<typeof setInterval>
  private attempt = 0
  private readonly WS: typeof WebSocket

  constructor(private readonly opts: TunnelOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket
  }

  get current() {
    return this.status
  }

  private set(s: RemoteStatus) {
    this.status = s
    this.opts.onStatus(s)
  }

  private log(line: string) {
    this.opts.log?.(line)
  }

  /** Resolves once the relay accepted the session; rejects with SignedOutError or a plain Error. */
  async start() {
    this.set({ state: "connecting", link: this.opts.link, key: this.key })
    const cred = await this.opts.credential()
    this.uid = cred.uid
    try {
      await this.open()
    } catch (error) {
      if (this.stopped) return
      if (error instanceof SignedOutError) throw error
      // A refused upgrade looks like a network error from a WebSocket client; ask plainly.
      const why = await this.diagnose()
      if (why) throw why
      this.log(`first connect failed, retrying: ${error}`)
      this.set({ state: "reconnecting", link: this.opts.link, key: this.key })
      this.scheduleRetry()
    }
    if (this.stopped) return
    this.tokenTimer = setInterval(() => void this.pushToken(), this.opts.tokenCheckMs ?? 5 * 60_000)
    ;(this.tokenTimer as any).unref?.()
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.retry)
    clearInterval(this.tokenTimer)
    for (const c of [...this.pending]) c.abandon?.(new Error("remote control off"))
    for (const c of this.conns) this.closeConn(c, 1000, "remote control off")
    this.conns.clear()
    this.grants = []
    this.set({ state: "off" })
  }

  /** The session changed (title, folder): tell the relay so the phone list stays current. */
  meta() {
    const m = this.opts.meta()
    for (const c of this.conns)
      if (c.welcomed) this.send(c, { t: "meta", title: m.title, directory: m.directory, path: m.path })
  }

  // ---------- connection lifecycle ----------
  private async open(force = false): Promise<Conn> {
    const { token, uid } = await this.opts.credential({ force })
    if (uid !== this.uid) throw new SignedOutError("You signed in as someone else. Run /rc again.")
    if (this.stopped) throw new Error("remote control off")
    this.lastToken = token
    const url = `${this.opts.relayUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/v1/agent?key=${this.key}`
    const ws = new this.WS(url, { headers: { authorization: `Bearer ${token}` } } as any)
    const conn: Conn = { ws, active: new Map(), draining: false, welcomed: false }
    this.pending.add(conn)
    return new Promise<Conn>((resolve, reject) => {
      // Settles the handshake exactly once: whichever of deadline, close, error or stop() comes
      // first removes the socket from `pending`, closes it and rejects; later events are no-ops.
      conn.abandon = (error) => {
        if (!this.pending.delete(conn)) return
        clearTimeout(conn.welcomeTimer)
        try {
          ws.close(1000, "handshake abandoned")
        } catch {}
        reject(error)
      }
      const welcomeMs = this.opts.welcomeMs ?? WELCOME_MS
      conn.welcomeTimer = setTimeout(
        () => conn.abandon?.(new Error(`relay sent no welcome within ${Math.round(welcomeMs / 1000)} s`)),
        welcomeMs,
      )
      ;(conn.welcomeTimer as any).unref?.()
      ws.onmessage = (e) => {
        let frame: Frame
        try {
          frame = JSON.parse(String(e.data))
        } catch {
          return
        }
        if (frame.t === "welcome" && !conn.welcomed) {
          // abandoned already (deadline, error or stop): ignore a late welcome
          if (!this.pending.delete(conn)) return
          clearTimeout(conn.welcomeTimer)
          conn.welcomed = true
          this.conns.add(conn)
          const m = this.opts.meta()
          this.send(conn, { t: "hello", ...m })
          this.attempt = 0
          // the newest socket takes new requests at the relay; older ones drain
          for (const other of this.conns) if (other !== conn) this.drain(other)
          conn.rotateTimer = setTimeout(() => void this.rotate(conn), this.opts.rotateMs ?? 50 * 60_000)
          ;(conn.rotateTimer as any).unref?.()
          if (!this.stopped) this.set({ state: "on", link: this.opts.link, key: this.key })
          resolve(conn)
          return
        }
        void this.onFrame(conn, frame)
      }
      ws.onclose = (e) => {
        if (!conn.welcomed) return conn.abandon?.(new Error(`relay closed the connection (${e.code})`))
        this.onClose(conn, e.code)
      }
      // A live socket's error is followed by close, which reconnects; before welcome it ends the attempt.
      ws.onerror = () => {
        if (!conn.welcomed) return conn.abandon?.(new Error("relay connection failed"))
        this.log("relay socket error")
      }
    })
  }

  private async rotate(conn: Conn) {
    if (this.stopped || !this.conns.has(conn)) return
    try {
      await this.open()
    } catch (error) {
      if (this.stopped) return
      if (error instanceof SignedOutError) return this.fail(error.message)
      // keep the old socket; Cloud Run may close it, then the reconnect loop takes over
      this.log(`rotation failed: ${error}`)
      conn.rotateTimer = setTimeout(() => void this.rotate(conn), 60_000)
    }
  }

  private drain(conn: Conn) {
    if (conn.draining) return
    conn.draining = true
    clearTimeout(conn.rotateTimer)
    const maybe = () => {
      if (conn.active.size === 0) this.closeConn(conn, 1000, "rotated")
    }
    maybe()
    conn.drainTimer = setTimeout(() => this.closeConn(conn, 1000, "rotated"), this.opts.drainMs ?? 5 * 60_000)
    ;(conn.drainTimer as any).unref?.()
  }

  private closeConn(conn: Conn, code: number, reason: string) {
    clearTimeout(conn.rotateTimer)
    clearTimeout(conn.drainTimer)
    for (const a of conn.active.values()) a.abort()
    conn.active.clear()
    this.conns.delete(conn)
    try {
      conn.ws.close(code, reason)
    } catch {}
  }

  private onClose(conn: Conn, code: number) {
    const wasLive = this.conns.has(conn) && !conn.draining
    clearTimeout(conn.rotateTimer)
    clearTimeout(conn.drainTimer)
    for (const a of conn.active.values()) a.abort()
    this.conns.delete(conn)
    if (this.stopped || !wasLive) return
    if ([...this.conns].some((c) => !c.draining)) return
    this.log(`socket closed (${code}); reconnecting`)
    this.set({ state: "reconnecting", link: this.opts.link, key: this.key })
    this.scheduleRetry(code === 4401)
  }

  private scheduleRetry(forceToken = false) {
    if (this.stopped) return
    clearTimeout(this.retry)
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.attempt, 6))
    const delay = this.attempt === 0 ? 250 : base / 2 + Math.random() * (base / 2)
    this.attempt++
    this.retry = setTimeout(async () => {
      try {
        await this.open(forceToken || this.attempt > 2)
      } catch (error) {
        if (this.stopped) return
        if (error instanceof SignedOutError) return this.fail(error.message)
        if (this.attempt > 3) {
          const why = await this.diagnose()
          if (why) return this.fail(why.message)
        }
        this.scheduleRetry()
      }
    }, delay)
  }

  private fail(message: string) {
    this.stop()
    this.set({ state: "error", message })
  }

  /** A refused handshake reads as a network error; ask the relay over plain HTTPS why. */
  private async diagnose(): Promise<Error | undefined> {
    try {
      const { token } = await this.opts.credential({ force: true })
      const res = await fetch(`${this.opts.relayUrl.replace(/\/+$/, "")}/v1/sessions`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      })
      if (res.status === 401) return new SignedOutError("Your Praex sign-in has expired. Run praex login, then /rc again.")
      if (res.status === 429) return new Error("You have too many Remote Control sessions open. Stop one, then try again.")
    } catch (error) {
      if (error instanceof SignedOutError) return error
    }
    return undefined
  }

  private async pushToken() {
    if (this.stopped) return
    try {
      const { token } = await this.opts.credential()
      if (token === this.lastToken) return
      this.lastToken = token
      for (const c of this.conns) if (c.welcomed) this.send(c, { t: "token", token })
    } catch (error) {
      if (error instanceof SignedOutError) this.fail(error.message)
    }
  }

  private send(conn: Conn, frame: Frame) {
    try {
      conn.ws.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  // ---------- frames from the relay ----------
  private async onFrame(conn: Conn, f: Frame) {
    if (f.t === "req") return this.serve(conn, f)
    if (f.t === "cancel") return conn.active.get(String(f.id))?.abort()
    if (f.t === "attach") {
      const uid = typeof f.idToken === "string" ? await this.opts.verifyPhone(f.idToken) : null
      if (!uid || uid !== this.uid) return this.send(conn, { t: "denied", id: f.id })
      const grant = randomKey(32)
      const now = this.now()
      this.grants = this.grants.filter((g) => g.exp > now)
      this.grants.push({ grant, exp: now + (this.opts.grantTtlMs ?? GRANT_TTL_MS) })
      if (this.grants.length > MAX_GRANTS) this.grants.shift()
      return this.send(conn, { t: "attached", id: f.id, grant })
    }
  }

  private now() {
    return this.opts.now?.() ?? Date.now()
  }

  /** true, false, or "expired" for a grant this process minted that has run out. */
  private async authorized(auth: any): Promise<boolean | "expired"> {
    if (!auth || typeof auth !== "object") return false
    if (typeof auth.grant === "string") {
      const found = this.grants.find((g) => sameSecret(g.grant, auth.grant))
      if (!found) return false
      if (found.exp > this.now()) return true
      this.grants = this.grants.filter((g) => g !== found)
      return "expired"
    }
    if (typeof auth.idToken === "string") return (await this.opts.verifyPhone(auth.idToken)) === this.uid
    return false
  }

  private reply(conn: Conn, id: string, status: number, message: string) {
    this.send(conn, { t: "res", id, status, headers: { "content-type": "application/json" } })
    this.send(conn, { t: "data", id, data: Buffer.from(JSON.stringify({ error: message })).toString("base64") })
    this.send(conn, { t: "end", id })
  }

  private async serve(conn: Conn, f: Frame) {
    const id = String(f.id)
    const ok = await this.authorized(f.auth)
    if (ok === "expired") return this.reply(conn, id, 401, GRANT_EXPIRED)
    if (!ok) return this.reply(conn, id, 401, "Not authorized for this computer.")
    // 10-20: method and body are settled before the check, and the same values are dispatched
    const method = typeof f.method === "string" ? f.method.toUpperCase() : "GET"
    const body = typeof f.body === "string" && method !== "GET" && method !== "HEAD" ? Buffer.from(f.body, "base64") : undefined
    const target = checkRemotePath(f.path, method, body)
    if (!target.ok) return this.reply(conn, id, target.status, target.message)

    const ctrl = new AbortController()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    conn.active.set(id, {
      abort: () => {
        ctrl.abort()
        reader?.cancel().catch(() => {})
      },
    })
    try {
      const headers = new Headers()
      for (const [k, v] of Object.entries(f.headers ?? {})) if (typeof v === "string") headers.set(k, v)
      const res = await this.opts.dispatch(
        new Request(target.url, { method, headers, body, signal: ctrl.signal }),
      )
      const outHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => (outHeaders[k] = v))
      this.send(conn, { t: "res", id, status: res.status, headers: outHeaders })
      if (res.body) {
        reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done || ctrl.signal.aborted) break
          for (let at = 0; at < value.byteLength; at += CHUNK) {
            this.send(conn, { t: "data", id, data: Buffer.from(value.subarray(at, at + CHUNK)).toString("base64") })
          }
          // crude backpressure: let the socket drain before queueing more
          while ((conn.ws as any).bufferedAmount > 4 * 1024 * 1024 && !ctrl.signal.aborted) await Bun.sleep(10)
        }
      }
      if (!ctrl.signal.aborted) this.send(conn, { t: "end", id })
    } catch (error) {
      if (!ctrl.signal.aborted) this.send(conn, { t: "error", id, message: "request failed" })
      this.log(`request failed: ${error instanceof Error ? error.message : error}`)
    } finally {
      conn.active.delete(id)
      if (conn.draining && conn.active.size === 0) this.closeConn(conn, 1000, "rotated")
    }
  }
}
