import Store from "electron-store"
import electron from "electron"

import { SETTINGS_STORE } from "./store-keys"

const cache = new Map<string, Store>()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\ai.opencode.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  // the name comes from the renderer over IPC and becomes a file name in userData (audit C13)
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.startsWith(".")) throw new Error(`invalid store name: ${name}`)
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(name, next)
  return next
}
