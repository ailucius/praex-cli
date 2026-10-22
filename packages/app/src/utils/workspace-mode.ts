import { createRoot, createSignal } from "solid-js"

// 10-22: which side of Chat | Code is picked. The sidebar sets it from the route and the toggle; the main
// area reads it to show the Code empty state when Code is picked and no folder is open (it showed the
// Chat home), and Ctrl+N starts a new session on the picked side (in Code it jumped back to Chat).
export type WorkspaceMode = "chat" | "code"
const [mode, setMode] = createRoot(() => createSignal<WorkspaceMode>("chat"))
export const workspaceMode = { get: mode, set: setMode }
