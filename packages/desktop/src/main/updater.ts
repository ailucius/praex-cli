import { app, dialog, shell } from "electron"
import pkg from "electron-updater"
import { MAC_SIGNED, UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"

const { autoUpdater } = pkg
const key = "ready"
export const DOWNLOAD_URL = "https://praex.ai/download"

// macOS installs go through Squirrel.Mac, which only accepts a Developer ID signed build.
export const CAN_INSTALL = process.platform !== "darwin" || MAC_SIGNED

export function setupAutoUpdater(input: { stop: () => Promise<void>; restart: () => Promise<void> }) {
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  // Never offer an older build: a rollback ships as a new, higher version. (Setting channel
  // above turns allowDowngrade on inside electron-updater, so it is set back here.)
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  let quitting = false
  app.once("before-quit", () => {
    quitting = true
  })

  const store = getStore("opencode.updater")
  const controller = createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: autoUpdater,
    persistence: {
      get() {
        const value = store.get(key)
        if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
        return { version: value.version } satisfies UpdaterReadyRecord
      },
      set: (value) => store.set(key, value),
      clear: () => store.delete(key),
    },
    stop: input.stop,
    restart: input.restart,
    canInstall: CAN_INSTALL,
    openDownload: () => void shell.openExternal(DOWNLOAD_URL),
    quitting: () => quitting,
    log: (message, data) => logger.log(message, data),
  })
  autoUpdater.on("error", (error) => controller.fail(error))
  return controller
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  if (state.manual) {
    const response = await dialog.showMessageBox({
      type: "info",
      message: "A new version is available",
      detail: `Praex ${state.version} is ready to download.`,
      title: "Update Available",
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    if (response.response === 0) await controller.install()
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response !== 0) return
  await controller.install().catch(async (error) => {
    await dialog.showMessageBox({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      title: "Update Error",
    })
  })
}
