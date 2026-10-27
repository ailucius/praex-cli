import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, utilityProcess } from "electron"
import { homedir } from "node:os"
import type { Details } from "electron"
import { getLogger } from "./logging"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import { DEFAULT_SERVER_URL_KEY } from "./store-keys"

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void> }

const SIDECAR_SERVICE_NAME = "praex server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000
// 10-27 (audit9 R9-13): absolute deadline for the startup health poll (index.ts also gives up at 30 s)
const SIDECAR_HEALTH_TIMEOUT = 30_000
const SIDECAR_HEALTH_INTERVAL = 100

type SpawnLocalServerOptions = {
  userDataPath: string
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
  healthTimeoutMs?: number
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  Object.assign(process.env, {
    ...(shell ? loadShellEnv(shell, getLogger()) : null),
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    // the user's home, never the launcher's cwd ("/" under AppImage) — it becomes the first project
    cwd: homedir(),
    env: createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
    })
  }).catch((error) => {
    if (!exited) child.kill()
    throw error
  })

  // 10-27 (audit9 R9-13): one cancellation scope for the startup health poll. It used to race an
  // endless loop against the child's exit and the loser kept polling. Now the poll ends on success,
  // child exit, the absolute deadline or stop(), and the abort also cancels the in-flight fetch.
  const health = new AbortController()
  let healthFailure: Error | undefined
  const endHealth = (error: Error) => {
    if (health.signal.aborted) return
    healthFailure = error
    health.abort()
  }

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    const timeoutMs = options.healthTimeoutMs ?? SIDECAR_HEALTH_TIMEOUT
    const deadline = setTimeout(
      () => endHealth(new Error(`Sidecar health check did not pass within ${timeoutMs}ms`)),
      timeoutMs,
    )
    void exit.promise.then((code) =>
      endHealth(new Error(`Sidecar exited before health check passed with code ${code}`)),
    )
    try {
      while (!health.signal.aborted) {
        await abortableDelay(SIDECAR_HEALTH_INTERVAL, health.signal)
        if (health.signal.aborted) break
        if (await checkHealth(url, password, health.signal)) return
      }
      throw healthFailure ?? new Error("Sidecar health check stopped")
    } finally {
      clearTimeout(deadline)
      health.abort()
    }
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        endHealth(new Error("Sidecar stopped before health check passed"))
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            if (!exited) child.kill()
          }),
        ])
        return stopping
      },
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null, signal?: AbortSignal): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      // 10-27 (audit9 R9-13): the caller's signal ends the request when startup health is settled
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

function createSidecarEnv(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  if (!app.isPackaged) env.OPENCODE_DISABLE_CHANNEL_DB = "1"
  return env
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
