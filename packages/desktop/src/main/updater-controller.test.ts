import { describe, expect, test } from "bun:test"
import {
  createUpdaterController,
  INSTALL_FAILED,
  type UpdaterBackend,
  type UpdaterReadyRecord,
} from "./updater-controller"

function setup(input?: {
  currentVersion?: string
  ready?: UpdaterReadyRecord
  canInstall?: boolean
  quitting?: boolean
  install?: () => void
}) {
  const calls: string[] = []
  const backend: UpdaterBackend = {
    async checkForUpdates() {
      calls.push("check")
      return { isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }
    },
    async downloadUpdate() {
      calls.push("download")
    },
    quitAndInstall() {
      calls.push("install")
      input?.install?.()
    },
  }
  let ready = input?.ready
  const controller = createUpdaterController({
    enabled: true,
    currentVersion: input?.currentVersion ?? "1.0.0",
    backend,
    persistence: {
      get: () => ready,
      set: (value) => {
        ready = value
      },
      clear: () => {
        ready = undefined
      },
    },
    stop: async () => {
      calls.push("stop")
    },
    restart: async () => {
      calls.push("restart")
    },
    canInstall: input?.canInstall,
    openDownload: () => calls.push("open-download"),
    quitting: () => input?.quitting ?? false,
    installTimeout: 20,
  })
  return { controller, calls, getReady: () => ready }
}

describe("updater controller", () => {
  test("checks, downloads, persists, and publishes one authoritative ready state", async () => {
    const app = setup()
    const states: ReturnType<typeof app.controller.getState>[] = []
    app.controller.subscribe((state) => states.push(state))

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.getReady()).toEqual({ version: "2.0.0" })
    expect(states.map((state) => state.status)).toEqual(["idle", "checking", "downloading", "ready"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("revalidates a persisted target through the updater cache on launch", async () => {
    const app = setup({ ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.calls).toEqual(["check", "download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })

  test("clears a target already installed before checking", async () => {
    const app = setup({ currentVersion: "2.0.0", ready: { version: "2.0.0" } })

    await app.controller.start()

    expect(app.getReady()).toBeUndefined()
    expect(app.calls).toEqual(["check"])
  })

  test("coalesces concurrent checks", async () => {
    const app = setup()

    await Promise.all([app.controller.check(), app.controller.check(), app.controller.check()])

    expect(app.calls).toEqual(["check", "download"])
  })

  test("restarts the server and reports an error when the app is still running after install", async () => {
    const app = setup()
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow(INSTALL_FAILED)

    expect(app.calls).toEqual(["check", "download", "stop", "install", "restart"])
    expect(app.controller.getState()).toEqual({ status: "error", message: INSTALL_FAILED })
  })

  test("restarts the server when the updater reports an install error", async () => {
    let fail: ((error: unknown) => void) | undefined
    const app = setup({ install: () => queueMicrotask(() => fail?.(new Error("code signature mismatch"))) })
    fail = (error) => app.controller.fail(error)
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow("code signature mismatch")

    expect(app.calls).toEqual(["check", "download", "stop", "install", "restart"])
    expect(app.controller.getState().status).toBe("error")
  })

  test("restarts the server when quitAndInstall throws", async () => {
    const app = setup({
      install: () => {
        throw new Error("pkexec cancelled")
      },
    })
    await app.controller.start()

    await expect(app.controller.install()).rejects.toThrow("pkexec cancelled")
    expect(app.calls.at(-1)).toBe("restart")
  })

  test("leaves the server stopped once the app is quitting to install", async () => {
    const app = setup({ quitting: true })
    await app.controller.start()

    await app.controller.install()

    expect(app.calls).toEqual(["check", "download", "stop", "install"])
    expect(app.controller.getState()).toEqual({ status: "installing", version: "2.0.0" })
  })

  test("offers a download instead of an install when the build cannot install in place", async () => {
    const app = setup({ canInstall: false })
    await app.controller.start()

    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0", manual: true })
    await app.controller.install()

    // No download, no server stop, no install attempt.
    expect(app.calls).toEqual(["check", "open-download"])
    expect(app.controller.getState()).toEqual({ status: "ready", version: "2.0.0", manual: true })
  })

  test("returns to ready when installation cannot start", async () => {
    const app = setup()
    await app.controller.start()

    const failed = createUpdaterController({
      enabled: true,
      currentVersion: "1.0.0",
      backend: {
        checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
        downloadUpdate: async () => {},
        quitAndInstall() {},
      },
      persistence: { get: () => undefined, set() {}, clear() {} },
      stop: async () => {
        throw new Error("stop failed")
      },
    })
    await failed.start()

    await expect(failed.install()).rejects.toThrow("stop failed")
    expect(failed.getState()).toEqual({ status: "ready", version: "2.0.0" })
  })
})
