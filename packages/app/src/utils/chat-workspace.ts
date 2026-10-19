import { createMemo } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"

/** Agents used by threads in the chat workspace. Mirror packages/opencode/src/agent/agent.ts. */
export const CHAT_AGENT = "chat"
export const COWORK_AGENT = "cowork"
export const WORKSPACE_AGENTS: readonly string[] = [CHAT_AGENT, COWORK_AGENT]

/**
 * The private workspace plain chats run in: `<state>/chat` on the server (Global.Path.chat).
 * The desktop app points the server's state dir at its own data dir, so this is never a
 * visible folder in the user's home.
 */
export function chatDirectory(state: string | undefined) {
  if (!state) return
  const windows = state[1] === ":" || state.startsWith("\\\\")
  const sep = windows ? "\\" : "/"
  return state.replace(/[\\/]+$/, "") + sep + "chat"
}

export function isChatDirectory(directory: string | undefined, chat: string | undefined) {
  if (!directory || !chat) return false
  return pathKey(directory) === pathKey(chat)
}

/** The chat workspace for the current server, once its paths have loaded. */
export function useChatDirectory() {
  const serverSync = useServerSync()
  return createMemo(() => chatDirectory(serverSync().data.path.state))
}
