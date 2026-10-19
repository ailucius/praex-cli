import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"

const id = "internal:home-footer"

// The start screen no longer needs its own status bar: the header carries the directory and
// version, and the prompt footer carries the permission mode, MCP trouble and key hints.
// The plugin stays registered (configs may reference its id) and leaves home_footer free for
// third-party plugins.
const tui: TuiPlugin = async () => {}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
