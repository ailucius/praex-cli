import { Global } from "@opencode-ai/core/global"
import { UI } from "../../ui"

// 10-22: `praex run` sometimes sat silent at start: the last log line was the bootstrap's "init",
// no request went out and it never ended. Startup now has a deadline: if the run has not created its
// session in time, it says which step it was in and exits with an error instead of hanging with
// nothing on screen. PRAEX_RUN_START_TIMEOUT (seconds) moves the deadline.
const DEFAULT_SECONDS = 60

let timer: ReturnType<typeof setTimeout> | undefined
let current = "loading the project"

export function seconds(env: Record<string, string | undefined> = process.env) {
  const value = Number(env.PRAEX_RUN_START_TIMEOUT)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SECONDS
}

export function message(step: string, waited: number, dataDir = Global.Path.data) {
  return [
    `Praex did not start within ${waited} s (stuck while ${step}).`,
    `Another Praex process may be holding ${dataDir}. Close other Praex windows or let them finish, then try again.`,
    `Run with --print-logs to see where it stopped. PRAEX_RUN_START_TIMEOUT=<seconds> gives it longer.`,
  ].join("\n")
}

export function start(onTimeout: (step: string, waited: number) => void = exit) {
  stop()
  current = "loading the project"
  const limit = seconds()
  timer = setTimeout(() => onTimeout(current, limit), limit * 1000)
}

export function step(name: string) {
  current = name
}

export function stop() {
  if (timer) clearTimeout(timer)
  timer = undefined
}

export function running() {
  return timer !== undefined
}

function exit(step: string, waited: number) {
  UI.error(message(step, waited))
  process.exit(1)
}

export * as StartupWatch from "./startup-watch"
