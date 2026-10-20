import type { UpdaterState } from "@opencode-ai/app/updater"

export type { UpdaterState } from "@opencode-ai/app/updater"

export type UpdaterReadyRecord = { version: string }

export type UpdaterBackend = {
  checkForUpdates(): Promise<{ isUpdateAvailable?: boolean; updateInfo?: { version?: string } } | null | undefined>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

type UpdaterPersistence = {
  get(): UpdaterReadyRecord | undefined | Promise<UpdaterReadyRecord | undefined>
  set(value: UpdaterReadyRecord): void | Promise<void>
  clear(): void | Promise<void>
}

export const INSTALL_FAILED = "The update could not be installed. Download it from praex.ai instead."

export function createUpdaterController(input: {
  enabled: boolean
  currentVersion: string
  backend: UpdaterBackend
  persistence: UpdaterPersistence
  stop: () => Promise<void>
  // Brings the local server back when an install did not go through.
  restart?: () => Promise<void>
  // 10-20: F11. False on macOS builds without a Developer ID: Squirrel.Mac refuses ad hoc signed
  // updates, so the new version is offered as a download instead of an in-app install.
  canInstall?: boolean
  openDownload?: () => void
  // True once the app has started quitting (the install went through).
  quitting?: () => boolean
  installTimeout?: number
  log?: (message: string, data?: object) => void
}) {
  let state: UpdaterState = input.enabled ? { status: "idle" } : { status: "disabled" }
  let pending: Promise<UpdaterState> | undefined
  let failInstall: ((error: unknown) => void) | undefined
  const manual = input.canInstall === false
  const listeners = new Set<(state: UpdaterState) => void>()

  const transition = (next: UpdaterState) => {
    input.log?.("updater state changed", { from: state.status, to: next.status })
    state = next
    listeners.forEach((listener) => listener(state))
    return state
  }

  const check = () => {
    if (!input.enabled) return Promise.resolve(state)
    if (state.status === "ready") return Promise.resolve(state)
    if (pending) return pending

    pending = (async () => {
      transition({ status: "checking" })
      const result = await input.backend.checkForUpdates()
      const version = result?.updateInfo?.version
      if (!result?.isUpdateAvailable || !version || version === input.currentVersion) {
        await input.persistence.clear()
        return transition({ status: "up-to-date" })
      }
      // Nothing to download when the update cannot be installed in place.
      if (manual) return transition({ status: "ready", version, manual: true })

      transition({ status: "downloading", version })
      await input.backend.downloadUpdate()
      await input.persistence.set({ version })
      return transition({ status: "ready", version })
    })()
      .catch((error) =>
        transition({ status: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        pending = undefined
      })
    return pending
  }

  return {
    getState: () => state,
    subscribe(listener: (state: UpdaterState) => void) {
      listeners.add(listener)
      listener(state)
      return () => listeners.delete(listener)
    },
    async start() {
      const ready = await input.persistence.get()
      if (ready?.version === input.currentVersion) await input.persistence.clear()
      return check()
    },
    check,
    // Called by the updater's error event; only matters while an install is in flight.
    fail(error: unknown) {
      failInstall?.(error)
    },
    async install() {
      if (state.status !== "ready") throw new Error("Update is not ready to install")
      const version = state.version
      if (manual) {
        input.openDownload?.()
        return
      }
      transition({ status: "installing", version })
      // The server is stopped only right before the install, and brought back if the app is
      // still running afterwards, so a failed install never leaves the window without a backend.
      try {
        await input.stop()
      } catch (error) {
        transition({ status: "ready", version })
        throw error
      }
      const failed = new Promise<unknown>((resolve) => {
        failInstall = resolve
        try {
          input.backend.quitAndInstall()
        } catch (error) {
          resolve(error)
        }
        const timer = setTimeout(() => resolve(undefined), input.installTimeout ?? 10_000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      const error = await failed
      failInstall = undefined
      if (!error && input.quitting?.()) return
      input.log?.("update install did not complete", { version, error: String(error ?? "timeout") })
      await input.restart?.().catch((cause) => input.log?.("server restart failed", { error: String(cause) }))
      const message = error instanceof Error && error.message ? `${INSTALL_FAILED} (${error.message})` : INSTALL_FAILED
      transition({ status: "error", message })
      throw new Error(message)
    },
  }
}

export type UpdaterController = ReturnType<typeof createUpdaterController>
