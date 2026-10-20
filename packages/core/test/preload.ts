// 10-20: core tests read config through Global, which resolves the XDG dirs at import. Without
// this they loaded the developer's real ~/.config/praex/config.json, so the result depended on
// whose machine ran them (public-opencode's switchModel tests were interrupted by a real config
// on the founder's machine and passed with a clean HOME). Same isolation as packages/opencode's
// test preload. Set before any src/ import.
import fs from "fs"
import os from "os"
import path from "path"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "praex-core-test-xdg-"))
process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }))
