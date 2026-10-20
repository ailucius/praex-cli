// 10-20: A14. One sender gate for every IPC channel. A message is served only when it comes from
// the main frame of a window we created (createMainWindow registers its webContents here) and
// that frame is showing our own renderer (renderer-origin.ts). Anything else, a subframe, a page
// that navigated away, a window we did not open, is refused before any store access,
// initialization data or sidecar/updater action. Per-operation checks (picked-file tokens,
// open-link and open-path allowlists) stay where they are; this runs in front of them.
// Only type imports from electron, so the gate is unit-testable under bun test.

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { isRendererUrl } from "./renderer-origin"

type FrameLike = {
  readonly url: string
  readonly parent: unknown
  readonly processId?: number
  readonly routingId?: number
}

type SenderLike = {
  readonly id: number
  readonly mainFrame?: FrameLike | null
}

export type IpcEventLike = {
  readonly sender: SenderLike
  readonly senderFrame?: FrameLike | null
}

type Trackable = { readonly id: number; once(event: "destroyed", listener: () => void): unknown }

export type SenderGate = {
  isTrustedContents: (id: number) => boolean
  isRendererUrl: (url: string) => boolean
}

const trustedContents = new Set<number>()

/** Called by createMainWindow for each window's webContents; forgotten when it is destroyed. */
export function trustWebContents(contents: Trackable) {
  trustedContents.add(contents.id)
  contents.once("destroyed", () => trustedContents.delete(contents.id))
}

const defaultGate: SenderGate = {
  isTrustedContents: (id) => trustedContents.has(id),
  isRendererUrl: (url) => isRendererUrl(url),
}

/** Why this IPC event must be refused, or null when it comes from our renderer's main frame. */
export function ipcSenderProblem(event: IpcEventLike, gate: SenderGate = defaultGate): string | null {
  if (!gate.isTrustedContents(event.sender.id)) return "unknown webContents"
  const frame = event.senderFrame
  // null when the frame navigated or was destroyed before the message was handled
  if (!frame) return "no sender frame"
  if (frame.parent !== null) return "not the main frame"
  const main = event.sender.mainFrame
  if (
    main &&
    frame !== main &&
    !(frame.processId !== undefined && frame.processId === main.processId && frame.routingId === main.routingId)
  )
    return "not the main frame"
  if (!gate.isRendererUrl(frame.url)) return "untrusted origin"
  return null
}

type Log = (message: string, data: Record<string, unknown>) => void

/**
 * ipcMain with the sender gate in front. `handle` rejects the renderer's invoke with an error,
 * `on` drops the message; both log the refusal. Register every channel through this.
 */
export function guardIpc(ipc: Pick<IpcMain, "handle" | "on">, log: Log = () => {}, gate: SenderGate = defaultGate) {
  const refuse = (channel: string, event: IpcEventLike) => {
    const problem = ipcSenderProblem(event, gate)
    if (problem) log("refused ipc", { channel, problem, url: event.senderFrame?.url })
    return problem
  }
  return {
    handle<A extends any[]>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: A) => unknown) {
      ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: any[]) => {
        if (refuse(channel, event)) throw new Error("Refused: this request did not come from the Praex window.")
        return listener(event, ...(args as A))
      })
    },
    on<A extends any[]>(channel: string, listener: (event: IpcMainEvent, ...args: A) => void) {
      ipc.on(channel, (event: IpcMainEvent, ...args: any[]) => {
        if (refuse(channel, event)) return
        listener(event, ...(args as A))
      })
    },
  }
}
