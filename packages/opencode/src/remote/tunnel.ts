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
import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Global } from "@opencode-ai/core/global"
import { PERMISSION_MODE_RULES, permissionModeOf, type PermissionMode } from "@opencode-ai/core/permission/mode"
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
  /**
   * The folders a request may name (checkRemoteDirectory). Not meta().directory: that is the folder's name for the
   * phone's list, not a path.
   */
  scope: () => RemoteScope | Promise<RemoteScope>
  /**
   * 22 Nov (audit 13): the permission mode chosen on the computer. Its rules are put on a session before a request
   * from the phone makes the model run in it. Missing, or throwing, counts as "manual".
   */
  mode?: () => PermissionMode
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
// 22 Nov (audit 13): how many sessions the tunnel remembers the applied permission mode for; the oldest is dropped.
const MAX_MODES = 500
// 24 Nov: how long a session's folder, once found in scope, is trusted without asking the server again
const FOLDER_TTL_MS = 5 * 60_000
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
// 22 Nov (audit 13): set by the tunnel on every request it dispatches, never taken from the phone (see serve()).
export const REMOTE_HEADER = "x-praex-remote"
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
// 11-13: more writes that go around the agent's permission prompts, refused the same way (any
// method other than a read). POST /vcs/apply runs `git apply` on a patch from the request, so
// it could drop a plugin (.opencode/plugins) or a praex.json with commands into the project,
// and the next instance load would run them. Moving a session (control plane) and creating,
// warping or removing a workspace apply patches and reset files across directories. Reloading
// the project (POST /instance/dispose) and upgrading the CLI (POST /global/upgrade) are done at
// the computer. Reads stay open (GET /vcs, /vcs/diff, the workspace list and status).
const HOST_ONLY = [
  /^\/(api\/)?vcs\/apply(\/|$)/i,
  /^\/(api\/)?instance\/dispose(\/|$)/i,
  /^\/(api\/)?experimental\/(control-plane|workspace)(\/|$)/i,
  /^\/(api\/)?global\/upgrade(\/|$)/i,
  // 16 Nov (audit 11 P0-CLI-02, P1-CLI-01): resetting a worktree runs git reset --hard, git clean and the project's
  // start script; copying a project writes files across the disk; disposing every instance is done at the computer
  /^\/(api\/)?experimental\/worktree\/reset(\/|$)/i,
  /^\/(api\/)?experimental\/project\/[^/]+\/copy(\/|$)/i,
  /^\/(api\/)?global\/dispose(\/|$)/i,
  // 17 Nov (audit 12 A12-01): replaying sync events writes session events as given, and a session.updated event can
  // carry any permission rules; it is the control plane's route between this machine's own servers, not the phone's
  /^\/(api\/)?sync\/replay(\/|$)/i,
  // 22 Nov (audit 13): the newer API's session writes. Creating a session there takes a location in the body and no
  // session rules, and its prompt carries file references this gate does not read. The phone app uses the older
  // /session routes, which are checked below. Reads, and the permission and question replies under
  // /api/session/:id/, stay open.
  /^\/api\/session\/[^/]+\/prompt(\/|$)/i,
  // 24 Nov (left open in 0.1.47): the newer API's compact (makes the model run, without the permission-mode step the
  // older summarize route gets) and wait. The phone app uses neither (it compacts through /session/:id/summarize).
  /^\/api\/session\/[^/]+\/(compact|wait)(\/|$)/i,
]
// 16 Nov (audit 11 P0-CLI-02): removing a worktree deletes a folder; done at the computer.
const HOST_ONLY_DELETE = [/^\/(api\/)?experimental\/worktree\/?$/i]
// 22 Nov (audit 13): routes refused over Remote Control for every method, reads included.
// - /tui drives the terminal UI on the computer: /tui/publish and /tui/execute-command make it run its own
//   commands, which include cycling the permission mode and the agent, and /tui/control hands out its requests.
// - /sync/history returns the whole event table of every project on this machine, and /sync/steal moves a session
//   to another workspace. Both are the control plane's routes between this machine's own servers.
// The phone app calls none of them.
// 24 Nov (left open in 0.1.47): /experimental/session lists the sessions of EVERY project on this machine (titles,
// folders), and /sync/start starts the workspace sync loops; the phone app calls neither.
const HOST_ONLY_ALL = [
  /^\/(api\/)?tui(\/|$)/i,
  /^\/(api\/)?sync\/(history|steal|start)(\/|$)/i,
  /^\/(api\/)?experimental\/session\/?$/i,
  // 24 Nov (independent review of the overnight patch): GET /api/session listed EVERY project's sessions when the
  // request named no folder, or named another project by ?project= or a crafted ?cursor= (proven live: the other
  // folder's session came back). Creating a session there was already refused; now every method is. The phone app
  // lists sessions through GET /session, which is scoped to the folder it names.
  /^\/api\/session\/?$/i,
]
// 10-20: routes the phone uses for ordinary things whose body can also carry a command, so the
// body is read instead of refusing the route: project edit (name and icon are fine, a startup
// script in commands.start is not), worktree create (a startCommand runs in a shell), and
// provider auth (a "wellknown" entry makes this machine load that server's remote config,
// which can add local MCP commands; API keys and OAuth tokens are fine).
type BodyRule = { re: RegExp; refuse: (body: any, method: string) => boolean; message?: string }
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim() !== ""
// 17 Nov (audit 12 A12-01): a session's own permission rules come after the agent's and the config's and the last
// match wins, so a phone that could write them could allow every tool, or lift the destructive-action guard, with
// no prompt at the computer (the TUI's manual mode is itself a set of session ask rules). Over Remote Control:
// - editing a session (title, archive, metadata) passes; a body that sets `permission` to anything is refused;
// - creating a session may only carry ask and deny rules: a new session has no earlier rules of its own, and the
//   agent's denies are put back after the session's (Permission.withSession), so those can only narrow. The app
//   creates every session with the guard's ask rule, so refusing all rules there would stop new sessions;
// - a prompt's deprecated `tools` map becomes session rules, so turning a tool on is refused; turning one off
//   (the app's web search toggle sends { websearch: false, webfetch: false }) passes.
const hasValue = (v: unknown) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)
const narrowingOnly = (rules: unknown) =>
  Array.isArray(rules) &&
  rules.every((r) => !!r && typeof r === "object" && ((r as any).action === "ask" || (r as any).action === "deny"))
const turnsToolOn = (tools: unknown) =>
  hasValue(tools) && (typeof tools !== "object" || Object.values(tools as object).some((v) => v !== false))
const PERMISSION_REFUSED =
  "Permission rules can only be widened on the computer, not over Remote Control. Answer each request from the phone instead."
// 22 Nov (audit 13): a prompt part of type "subtask" starts a subagent directly, with no agent check and no
// permission request, and a subagent's session does not carry the manual mode's ask rules. The phone app never
// sends one; the model can still start a subagent through its task tool, which asks in manual mode.
export const SUBTASK_REFUSED = "Subagent tasks can not be started over Remote Control."
const hasSubtask = (parts: unknown) =>
  Array.isArray(parts) && parts.some((p) => !!p && typeof p === "object" && (p as any).type === "subtask")
const BODY_RULES: BodyRule[] = [
  { re: /^\/(api\/)?project\/[^/]+\/?$/i, refuse: (b) => !!b?.commands && Object.values(b.commands).some(nonEmpty) },
  { re: /^\/(api\/)?experimental\/worktree\/?$/i, refuse: (b) => nonEmpty(b?.startCommand) },
  // removing a credential (DELETE) carries no body and runs nothing
  { re: /^\/(api\/)?auth\/[^/]+\/?$/i, refuse: (b, m) => m !== "DELETE" && b?.type !== "api" && b?.type !== "oauth" },
  // session create (POST /session)
  {
    re: /^\/(api\/)?session\/?$/i,
    refuse: (b) => hasValue(b?.permission) && !narrowingOnly(b.permission),
    message: PERMISSION_REFUSED,
  },
  // session update (PATCH /session/:id); removing one (DELETE) carries no body
  { re: /^\/(api\/)?session\/[^/]+\/?$/i, refuse: (b) => hasValue(b?.permission), message: PERMISSION_REFUSED },
  // prompts (POST /session/:id/message, /session/:id/prompt_async)
  {
    re: /^\/(api\/)?session\/[^/]+\/(message|prompt_async)\/?$/i,
    refuse: (b) => turnsToolOn(b?.tools),
    message: PERMISSION_REFUSED,
  },
  // 22 Nov (audit 13): prompts and commands (POST /session/:id/message, /prompt_async, /command) with a subtask part
  {
    re: /^\/(api\/)?session\/[^/]+\/(message|prompt_async|command)\/?$/i,
    refuse: (b) => hasSubtask(b?.parts),
    message: SUBTASK_REFUSED,
  },
]

export type PathCheck = { ok: true; url: string } | { ok: false; status: 400 | 403; message: string }

const CONFIG_REFUSED = "Settings that can run commands can only be changed on the computer, not over Remote Control."
const HOST_ONLY_REFUSED = "This can only be done on the computer, not over Remote Control."

type ParsedBody = { ok: true; value: unknown } | { ok: false }
function parseBody(body: Uint8Array | undefined): ParsedBody {
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
  return checkRemoteRequest(path, method, body, {})
}

// 22 Nov (audit 13): the same check, which also leaves the request body in `seen` when a body rule had to parse
// it, so serve() does not parse it a second time for checkRemoteParts.
function checkRemoteRequest(
  path: unknown,
  method: string,
  body: Uint8Array | undefined,
  seen: { parsed?: ParsedBody },
): PathCheck {
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
  let pathname = url.pathname
  for (let round = 0; round < 4; round++) {
    const flat = pathname.replace(/\/{2,}/g, "/")
    if (BLOCKED.some((re) => re.test(flat)))
      return { ok: false, status: 403, message: "The terminal and shell are not available over Remote Control." }
    if (HOST_ONLY_ALL.some((re) => re.test(flat))) return { ok: false, status: 403, message: HOST_ONLY_REFUSED }
    if (write && NO_WRITE.some((re) => re.test(flat))) return { ok: false, status: 403, message: CONFIG_REFUSED }
    if (write && HOST_ONLY.some((re) => re.test(flat))) return { ok: false, status: 403, message: HOST_ONLY_REFUSED }
    if (method === "DELETE" && HOST_ONLY_DELETE.some((re) => re.test(flat)))
      return { ok: false, status: 403, message: HOST_ONLY_REFUSED }
    if (write) {
      for (const rule of BODY_RULES) {
        if (!rule.re.test(flat)) continue
        const parsed = (seen.parsed ??= parseBody(body))
        if (!parsed.ok) return { ok: false, status: 400, message: "Bad request body." }
        if (rule.refuse(parsed.value, method)) return { ok: false, status: 403, message: rule.message ?? CONFIG_REFUSED }
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

export const DIRECTORY_REFUSED = "Over Remote Control only this project's folder and its own worktrees are available."
/**
 * The folder holding one project's worktrees. Worktrees are created at <data>/worktree/<project id>/<name>
 * (src/worktree/index.ts), so this is the only part of the worktree folder that belongs to that project.
 * Undefined for a project without an id of its own (no git, so no worktrees).
 */
export function projectWorktreeFolder(projectID: string | undefined, data = Global.Path.data): string | undefined {
  if (!projectID || projectID === "global" || projectID === "." || projectID === ".." || /[\\/]/.test(projectID))
    return undefined
  return path.join(data, "worktree", projectID)
}
/** What a remote request may name as its directory; see checkRemoteDirectory. */
export type RemoteScope = {
  /** Full paths of the folders Remote Control serves: where it was started, and the folder the computer has open. */
  roots: string[]
  /** This project's worktree folder (projectWorktreeFolder), when it has one. */
  worktrees?: string
}
const realOrSelf = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
/**
 * Every directory a remote request names (?directory=, ?location[directory]=, any ...[directory]= query key, and the
 * x-opencode-directory header) must be one of `roots` (the project folder Remote Control was started in), a folder
 * inside one, or a folder inside `worktrees`, this project's own worktree folder (<data>/worktree/<project id>).
 * 17 Nov (audit 12 A12-02): the whole <data>/worktree folder used to pass, which let Remote Control for one project
 * reach the worktrees of every other project on the machine. Symlinks are resolved first.
 */
export function checkRemoteDirectory(
  url: string,
  headers: unknown,
  roots: string | readonly string[],
  worktrees: string | undefined,
): boolean {
  const names: string[] = []
  try {
    for (const [k, v] of new URL(url).searchParams) if (k === "directory" || /\[directory\]$/.test(k)) names.push(v)
  } catch {
    return false
  }
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>))
      if (k.toLowerCase() === "x-opencode-directory" && typeof v === "string") names.push(v)
  }
  if (!names.length) return true
  const inScope = scopeTest(roots, worktrees)
  return names.every((n) => {
    let d = n
    try {
      d = decodeURIComponent(n)
    } catch {}
    if (!path.isAbsolute(d)) return false
    return inScope(d)
  })
}
// The test both checks share: is this full path one of the roots, inside one, or inside the worktree folder, once
// symlinks are resolved.
function scopeTest(roots: string | readonly string[], worktrees: string | undefined) {
  // only absolute roots count: a relative one would resolve against wherever this process happens to run
  const bases = (typeof roots === "string" ? [roots] : roots).filter((r) => path.isAbsolute(r)).map(realOrSelf)
  const trees = worktrees && path.isAbsolute(worktrees) ? realOrSelf(worktrees) : undefined
  const inside = (r: string, base: string) => r === base || r.startsWith(base + path.sep)
  return (full: string) => {
    const r = realOrSelf(full)
    return bases.some((b) => inside(r, b)) || (!!trees && r.startsWith(trees + path.sep))
  }
}

export const PARTS_REFUSED = "Over Remote Control only files in this project's folder can be attached."
/**
 * 22 Nov (audit 13): a prompt part of type file with a file: url is read on the computer with no permission request
 * (src/session/prompt.ts), and with noReply the content comes straight back, so the phone could read any file the
 * user can. Every entry of the body's `parts` that carries a url, and the body's own `url` when it has one, is
 * looked at: a url that parses to the file: protocol must point at one of `roots`, inside one, or inside
 * `worktrees` (the test checkRemoteDirectory uses, symlinks resolved first). A file: url that can not be turned into
 * a path is refused. Other protocols (data: for pasted images) and urls that do not parse pass; the server deals
 * with those. The url is parsed the way the server parses it (new URL, then fileURLToPath).
 */
export function checkRemoteParts(body: unknown, roots: string | readonly string[], worktrees: string | undefined): boolean {
  if (!body || typeof body !== "object") return true
  const urls: string[] = []
  const own = (body as { url?: unknown }).url
  if (typeof own === "string") urls.push(own)
  const parts = (body as { parts?: unknown }).parts
  if (Array.isArray(parts))
    for (const part of parts) if (part && typeof part === "object" && typeof part.url === "string") urls.push(part.url)
  if (!urls.length) return true
  const inScope = scopeTest(roots, worktrees)
  return urls.every((value) => {
    let protocol: string
    try {
      protocol = new URL(value).protocol
    } catch {
      return true
    }
    if (protocol !== "file:") return true
    let file: string
    try {
      file = fileURLToPath(value)
    } catch {
      return false
    }
    return path.isAbsolute(file) && inScope(file)
  })
}

// 22 Nov (audit 13): the routes that make the model run in a session: a prompt, a command, the init command, and a
// summarize (with auto set the model carries on after it). Before one of them is dispatched the tunnel puts the
// computer's permission mode on that session (RemoteTunnel.applyMode).
const MODEL_ROUTE = /^\/(?:api\/)?session\/([^/]+)\/(?:message|prompt_async|command|init|summarize)\/?$/i
const PLAIN_SESSION_ID = /^[A-Za-z0-9_-]+$/
export const MODE_REFUSED = "Couldn't apply the computer's permission mode to this session. Try again."
/**
 * The session a request would make the model run in: undefined for any other route, "bad" when the route is one of
 * them but the session id is not a plain id, or the route only shows after percent-decoding (the tunnel must be
 * able to name the very session the server will use, so an encoded spelling is refused instead of guessed at).
 * `pathname` is the one checkRemotePath handed back; it is tested the way that check tests it.
 */
export function remoteModelSession(pathname: string): { id: string } | "bad" | undefined {
  let current = pathname
  for (let round = 0; round < 4; round++) {
    const match = MODEL_ROUTE.exec(current.replace(/\/{2,}/g, "/"))
    if (match) return round === 0 && PLAIN_SESSION_ID.test(match[1]) ? { id: match[1] } : "bad"
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return undefined
    }
    if (decoded === current) return undefined
    try {
      current = new URL(ORIGIN + decoded).pathname
    } catch {
      return undefined
    }
  }
  return undefined
}

// 24 Nov (left open in 0.1.47): any route that names a session by id, in the older API, the newer one or the
// experimental background route. The server runs such a request in THAT SESSION'S OWN folder whatever ?directory=
// says (workspace-routing.ts: session.directory wins), so checkRemoteDirectory alone let a phone reach another
// project's session by its id. The tunnel now looks the session up and refuses one whose folder is out of scope.
const SESSION_ROUTE = /^\/(?:api\/)?(?:experimental\/)?session\/([^/]+)(?:\/|$)/i
const NOT_A_SESSION = new Set(["status"])
export const SESSION_CHECK_FAILED = "Couldn't check which project this session belongs to. Try again."
// Marks the tunnel's own session lookup (sessionFolder), so it can be told apart from a phone's request in tests and
// logs; the server ignores it.
export const SESSION_CHECK_HEADER = "x-praex-session-check"
/**
 * The session a request names: undefined when it names none, "bad" when the id is not a plain id or the route only
 * shows after percent-decoding (the tunnel must check the very session the server will use, so an encoded spelling is
 * refused instead of guessed at). Same reading as remoteModelSession.
 */
export function remoteSessionRef(pathname: string): { id: string } | "bad" | undefined {
  let current = pathname
  for (let round = 0; round < 4; round++) {
    const match = SESSION_ROUTE.exec(current.replace(/\/{2,}/g, "/"))
    if (match && NOT_A_SESSION.has(match[1].toLowerCase())) return round === 0 ? undefined : "bad"
    if (match) return round === 0 && PLAIN_SESSION_ID.test(match[1]) ? { id: match[1] } : "bad"
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return undefined
    }
    if (decoded === current) return undefined
    try {
      current = new URL(ORIGIN + decoded).pathname
    } catch {
      return undefined
    }
  }
  return undefined
}

// 24 Nov (independent review): GET /global/event streams the events of EVERY project this server has open (session and
// message events included). The phone app needs the stream, so instead of refusing it the tunnel drops what belongs
// to a folder outside the scope. Each event is one SSE block whose data line is {directory?, project?, workspace?,
// payload}; directory is a full path, or "global" for machine-wide events (an update notice, a workspace status, a
// project's details).
const GLOBAL_EVENT_ROUTE = /^\/(?:api\/)?global\/event\/?$/i
/** Whether a global event may go to the phone: its folder is in scope, or it belongs to no folder. */
export function keepGlobalEvent(event: unknown, inScope: (full: string) => boolean): boolean {
  if (!event || typeof event !== "object") return true
  const e = event as { directory?: unknown; payload?: { type?: unknown; properties?: { worktree?: unknown } } }
  if (typeof e.directory === "string" && e.directory !== "global") return path.isAbsolute(e.directory) && inScope(e.directory)
  // a project's details (name, root folder): only this project's
  if (e.payload?.type === "project.updated") {
    const root = e.payload.properties?.worktree
    return typeof root === "string" && path.isAbsolute(root) && inScope(root)
  }
  return true
}
/** The SSE stream with every event that keep() refuses taken out; blocks are cut at blank lines. */
export function filterEventStream(body: ReadableStream<Uint8Array>, keep: (event: unknown) => boolean): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const pass = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n")
    if (!data) return true
    try {
      return keep(JSON.parse(data))
    } catch {
      return true // not JSON (a comment or keep-alive): nothing to leak
    }
  }
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          if (buffer && pass(buffer)) controller.enqueue(encoder.encode(buffer))
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let out = ""
        for (let cut = buffer.search(/\r?\n\r?\n/); cut >= 0; cut = buffer.search(/\r?\n\r?\n/)) {
          const end = buffer.indexOf("\n", buffer.indexOf("\n", cut) + 1) + 1
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end)
          if (pass(block)) out += block
        }
        if (out) {
          controller.enqueue(encoder.encode(out))
          return
        }
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export const randomKey = (bytes = 16) => randomBytes(bytes).toString("base64url")

export class RemoteTunnel {
  readonly key = randomKey()
  private conns = new Set<Conn>()
  // Sockets still waiting for the relay's welcome; tracked from creation so stop() can cancel them.
  private pending = new Set<Conn>()
  private grants: { grant: string; exp: number }[] = []
  // 22 Nov (audit 13): the permission mode this tunnel last put on each session (session id to mode), oldest first.
  private modes = new Map<string, PermissionMode>()
  // 24 Nov: session id -> its folder, for sessions found in scope (sessionFolder)
  private folders = new Map<string, { folder: string; at: number }>()
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
    this.modes.clear()
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

  /** The computer's permission mode right now; "manual" when it is not known. */
  private mode(): PermissionMode {
    try {
      return permissionModeOf(this.opts.mode?.())
    } catch {
      return "manual"
    }
  }

  /**
   * 22 Nov (audit 13): the TUI's manual mode is a set of session ask rules that only the TUI pushed, and only onto
   * a session the TUI itself opened. A session the phone created, forked or prompted had what the phone sent, so in
   * manual mode it ran edits and shell commands without asking. Before a request makes the model run in a session,
   * the tunnel sends its own PATCH /session/<id> with the rules of the computer's current mode, in-process, with the
   * phone request's query string and headers so it reaches the same project. It goes straight to dispatch, not
   * through checkRemotePath, which rightly refuses permission rules from the phone. False (the session could not
   * be updated, or the update threw) means the phone's request must not be dispatched. Each session gets the
   * update once per mode; a mode change on the computer sends it again on the next request.
   */
  private async applyMode(sessionID: string, url: string, forwarded: Headers, signal: AbortSignal): Promise<boolean> {
    const mode = this.mode()
    if (this.modes.get(sessionID) === mode) return true
    try {
      const headers = new Headers(forwarded)
      headers.set("content-type", "application/json")
      // the phone's content-length belongs to the phone's body, not to this one
      headers.delete("content-length")
      const res = await this.opts.dispatch(
        new Request(`${ORIGIN}/session/${sessionID}${new URL(url).search}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ permission: PERMISSION_MODE_RULES[mode] }),
          signal,
        }),
      )
      await res.body?.cancel().catch(() => {})
      if (!res.ok) {
        this.log(`permission mode not applied to the session (${res.status})`)
        return false
      }
    } catch (error) {
      this.log(`permission mode not applied to the session: ${error instanceof Error ? error.message : error}`)
      return false
    }
    this.modes.delete(sessionID)
    this.modes.set(sessionID, mode)
    if (this.modes.size > MAX_MODES) this.modes.delete(this.modes.keys().next().value!)
    return true
  }

  /**
   * The folder a session works in, asked of this machine's own server (GET /session/:id without ?directory=, so the
   * server answers from the session itself). undefined = no such session (the request then gets the server's own
   * 404), "error" = the answer could not be read. A folder found in scope is remembered for a few minutes.
   */
  private async sessionFolder(sessionID: string, frameHeaders: Frame["headers"]): Promise<string | undefined | "error"> {
    const hit = this.folders.get(sessionID)
    if (hit && Date.now() - hit.at < FOLDER_TTL_MS) return hit.folder
    try {
      const headers = new Headers()
      for (const [k, v] of Object.entries(frameHeaders ?? {}))
        if (typeof v === "string" && k.toLowerCase() !== REMOTE_HEADER && k.toLowerCase() !== "content-length" && k.toLowerCase() !== "content-type")
          headers.set(k, v)
      headers.set(REMOTE_HEADER, "1")
      headers.set(SESSION_CHECK_HEADER, "1")
      const res = await this.opts.dispatch(
        new Request(`${ORIGIN}/session/${sessionID}`, { method: "GET", headers, signal: AbortSignal.timeout(10_000) }),
      )
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {})
        return undefined
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        return "error"
      }
      const info = (await res.json().catch(() => null)) as { directory?: unknown } | null
      return typeof info?.directory === "string" && info.directory ? info.directory : "error"
    } catch (error) {
      this.log(`session folder not read: ${error instanceof Error ? error.message : error}`)
      return "error"
    }
  }

  private remember(sessionID: string, folder: string) {
    this.folders.delete(sessionID)
    this.folders.set(sessionID, { folder, at: Date.now() })
    if (this.folders.size > MAX_MODES) this.folders.delete(this.folders.keys().next().value!)
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
    const seen: { parsed?: ParsedBody } = {}
    const target = checkRemoteRequest(f.path, method, body, seen)
    if (!target.ok) return this.reply(conn, id, target.status, target.message)
    // 16 Nov (audit 11 P0-CLI-01): a request may only name this project's folder (or a worktree of it) as its
    // directory, so Remote Control can not read files or load plugins from anywhere else on the computer.
    // 17 Nov (audit 12 A12-02): checked against the scope's full paths and this project's own worktree folder; the
    // check used to get meta().directory, which is only the folder's name, resolved against this process's cwd.
    let scope: RemoteScope
    try {
      scope = await this.opts.scope()
    } catch {
      scope = { roots: [] }
    }
    if (!checkRemoteDirectory(target.url, f.headers, scope.roots, scope.worktrees))
      return this.reply(conn, id, 403, DIRECTORY_REFUSED)
    // 22 Nov (audit 13): files a prompt or command attaches by file: url must be in the same folders. Every write
    // with a JSON body is looked at, whatever its route; a body that is not JSON carries no parts the server reads
    // (the prompt and command routes refuse such a body above).
    const write = !READ_METHODS.has(method)
    if (write && body?.byteLength) {
      const json = seen.parsed ?? parseBody(body)
      if (json.ok && !checkRemoteParts(json.value, scope.roots, scope.worktrees))
        return this.reply(conn, id, 403, PARTS_REFUSED)
    }
    // 24 Nov (left open in 0.1.47): a request that names a session runs in that session's own folder, whatever folder
    // it names, so the session's folder must be in scope too (see SESSION_ROUTE).
    const named = remoteSessionRef(new URL(target.url).pathname)
    if (named === "bad") return this.reply(conn, id, 400, "Bad path.")
    if (named) {
      const folder = await this.sessionFolder(named.id, f.headers)
      if (folder === "error") return this.reply(conn, id, 503, SESSION_CHECK_FAILED)
      if (folder !== undefined) {
        if (!scopeTest(scope.roots, scope.worktrees)(folder)) return this.reply(conn, id, 403, DIRECTORY_REFUSED)
        this.remember(named.id, folder)
      }
    }
    // 22 Nov (audit 13): a request that makes the model run names its session by a plain id, so the computer's
    // permission mode can be put on that very session first (below, once the request can be cancelled).
    const session = write ? remoteModelSession(new URL(target.url).pathname) : undefined
    if (session === "bad") return this.reply(conn, id, 400, "Bad path.")

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
      // 22 Nov (audit 13): x-praex-remote marks a request as coming over Remote Control, for the server routes that
      // treat one differently (the session command route runs no shell text from the caller). Only the tunnel may
      // set it: whatever the phone sent under that name, in any letter case, is dropped.
      for (const [k, v] of Object.entries(f.headers ?? {}))
        if (typeof v === "string" && k.toLowerCase() !== REMOTE_HEADER) headers.set(k, v)
      headers.set(REMOTE_HEADER, "1")
      if (session) {
        const applied = await this.applyMode(session.id, target.url, headers, ctrl.signal)
        if (ctrl.signal.aborted) return
        if (!applied) return this.reply(conn, id, 503, MODE_REFUSED)
      }
      const res = await this.opts.dispatch(
        new Request(target.url, { method, headers, body, signal: ctrl.signal }),
      )
      const outHeaders: Record<string, string> = {}
      res.headers.forEach((v, k) => (outHeaders[k] = v))
      this.send(conn, { t: "res", id, status: res.status, headers: outHeaders })
      // 24 Nov: other projects' events are taken out of the global event stream (see GLOBAL_EVENT_ROUTE)
      const filtered =
        res.body && method === "GET" && GLOBAL_EVENT_ROUTE.test(new URL(target.url).pathname)
          ? filterEventStream(res.body, (event) => keepGlobalEvent(event, scopeTest(scope.roots, scope.worktrees)))
          : res.body
      if (filtered) {
        reader = filtered.getReader()
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
