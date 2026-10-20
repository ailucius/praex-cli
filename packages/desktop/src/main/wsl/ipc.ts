import { app, ipcMain } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import type { WslServersController } from "./servers"
import { requireWslIpcString } from "./policy"
import { guardIpc } from "../ipc-trust"
import { write as writeLog } from "../logging"
import type { WslServersState } from "../../preload/types"

// 10-20: A14. WSL channels start installs and sidecars, so they sit behind the same sender gate
const ipc = guardIpc(ipcMain, (message, data) => writeLog("ipc", message, data, "warn"))

export function registerWslIpcHandlers(controller: WslServersController) {
  if (process.platform !== "win32") {
    registerUnavailableWslIpcHandlers()
    return
  }

  const subscriptions = new Map<number, () => void>()
  const unsubscribe = (id: number) => {
    const off = subscriptions.get(id)
    if (!off) return
    off()
    subscriptions.delete(id)
  }

  app.once("will-quit", () => {
    subscriptions.forEach((off) => off())
    subscriptions.clear()
  })

  ipc.handle("wsl-servers-subscribe", (event) => {
    const id = event.sender.id
    if (subscriptions.has(id)) return
    subscriptions.set(
      id,
      controller.subscribe((payload) => {
        if (event.sender.isDestroyed()) {
          unsubscribe(id)
          return
        }
        event.sender.send("wsl-servers-event", payload)
      }),
    )
    event.sender.once("destroyed", () => unsubscribe(id))
  })
  ipc.handle("wsl-servers-unsubscribe", (event) => unsubscribe(event.sender.id))
  ipc.handle("wsl-servers-get-state", () => controller.getState())
  ipc.handle("wsl-servers-probe-runtime", () => controller.probeRuntime())
  ipc.handle("wsl-servers-refresh-distros", () => controller.refreshDistros())
  ipc.handle("wsl-servers-install-wsl", () => controller.installWsl())
  ipc.handle("wsl-servers-install-distro", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installDistro(requireWslIpcString("distro", name)),
  )
  ipc.handle("wsl-servers-probe-distro", (_event: IpcMainInvokeEvent, name: string) =>
    controller.probeDistro(requireWslIpcString("distro", name)),
  )
  ipc.handle("wsl-servers-probe-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    controller.probeOpencode(requireWslIpcString("distro", name)),
  )
  ipc.handle("wsl-servers-install-opencode", (_event: IpcMainInvokeEvent, name: string) =>
    controller.installOpencode(requireWslIpcString("distro", name)),
  )
  ipc.handle("wsl-servers-open-terminal", (_event: IpcMainInvokeEvent, name: string) =>
    controller.openTerminal(requireWslIpcString("distro", name)),
  )
  ipc.handle("wsl-servers-add", (_event: IpcMainInvokeEvent, distro: string) =>
    controller.addServer(requireWslIpcString("distro", distro)),
  )
  ipc.handle("wsl-servers-remove", (_event: IpcMainInvokeEvent, id: string) =>
    controller.removeServer(requireWslIpcString("server id", id)),
  )
  ipc.handle("wsl-servers-start", (_event: IpcMainInvokeEvent, id: string) =>
    controller.startServer(requireWslIpcString("server id", id)),
  )
}

function registerUnavailableWslIpcHandlers() {
  const unavailable = () => {
    throw new Error("WSL is only available on Windows")
  }
  const state = (): WslServersState => ({
    runtime: {
      available: false,
      version: null,
      error: "WSL is only available on Windows",
    },
    installed: [],
    online: [],
    distroProbes: {},
    opencodeChecks: {},
    pendingRestart: false,
    servers: [],
    job: null,
  })

  ipc.handle("wsl-servers-subscribe", (event) => {
    event.sender.send("wsl-servers-event", { type: "state", state: state() })
  })
  ipc.handle("wsl-servers-unsubscribe", () => undefined)
  ipc.handle("wsl-servers-get-state", () => state())
  ipc.handle("wsl-servers-probe-runtime", unavailable)
  ipc.handle("wsl-servers-refresh-distros", unavailable)
  ipc.handle("wsl-servers-install-wsl", unavailable)
  ipc.handle("wsl-servers-install-distro", unavailable)
  ipc.handle("wsl-servers-probe-distro", unavailable)
  ipc.handle("wsl-servers-probe-opencode", unavailable)
  ipc.handle("wsl-servers-install-opencode", unavailable)
  ipc.handle("wsl-servers-open-terminal", unavailable)
  ipc.handle("wsl-servers-add", unavailable)
  ipc.handle("wsl-servers-remove", unavailable)
  ipc.handle("wsl-servers-start", unavailable)
}
