// 10-28 (founder: "other tool calling and other things we are missing"): Claude Code can start a dev server or a long
// build in the background and keep working; Praex could not, every command held the turn until it ended or timed out.
// background=true starts the command detached, sends its output to a log file and returns at once. When the command
// exits on its own the session gets a message with the exit code and the last lines of output (a command stopped with
// a signal, usually by the agent itself, is not reported). Commands still running when Praex exits are stopped.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { Shell } from "@opencode-ai/core/shell"
import { TRUNCATION_DIR } from "../truncation-dir"
import { ToolID } from "../schema"

export type Exit = { code: number | null; signal: NodeJS.Signals | null; tail: string }

const running = new Map<number, ChildProcess>()
let hooked = false

// The tool-output folder: reading it needs no approval (agent.ts allows Truncate.GLOB) and old files are cleaned up there.
export const logDir = () => TRUNCATION_DIR

// The last lines of a log, read from its end so a huge log costs no more than maxBytes.
export function tail(file: string, lines = 20, maxBytes = 8000): string {
  let fd: number | undefined
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    fd = fs.openSync(file, "r")
    fs.readSync(fd, buf, 0, buf.length, start)
    const text = buf.toString("utf8")
    // a cut at the start can split a line: drop the partial first line
    const all = (start > 0 ? text.slice(text.indexOf("\n") + 1) : text).replace(/\s+$/, "").split("\n")
    return all.slice(-lines).join("\n")
  } catch {
    return ""
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

// How to stop it: on POSIX the command leads its own process group, so the group signal also stops what it started
// (npm run dev -> node -> vite).
export const stopHint = (pid: number) =>
  process.platform === "win32" ? `taskkill /PID ${pid} /T /F` : `kill -- -${pid}`

export function stopAll() {
  for (const [pid, child] of running) {
    try {
      if (process.platform === "win32") child.kill()
      else process.kill(-pid, "SIGTERM")
    } catch {}
  }
  running.clear()
}

export const runningCount = () => running.size

export function start(input: {
  shell: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  onExit: (exit: Exit) => void
}): { pid: number; log: string } {
  fs.mkdirSync(logDir(), { recursive: true })
  const log = path.join(logDir(), ToolID.ascending())
  const fd = fs.openSync(log, "a")
  const win = process.platform === "win32"
  let child: ChildProcess
  try {
    const options: SpawnOptions = { cwd: input.cwd, env: input.env, stdio: ["ignore", fd, fd], windowsHide: true }
    child =
      win && Shell.ps(input.shell)
        ? spawn(input.shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", input.command], options)
        : spawn(input.command, { ...options, shell: input.shell, detached: !win })
  } finally {
    fs.closeSync(fd)
  }
  // a failed spawn reports through "error" after this returns; without a listener that would crash the process
  child.once("error", () => {
    if (child.pid) running.delete(child.pid)
  })
  const pid = child.pid
  if (!pid) throw new Error(`Could not start the command in the background (${input.shell})`)
  running.set(pid, child)
  if (!hooked) {
    hooked = true
    process.once("exit", stopAll)
  }
  child.once("exit", (code, signal) => {
    running.delete(pid)
    input.onExit({ code, signal, tail: tail(log) })
  })
  child.unref()
  return { pid, log }
}
