// The runtime permission modes and the session rules each one stands for.
// 22 Nov (audit 13): moved here from packages/tui/src/context/local.tsx so the Remote Control tunnel
// (packages/opencode/src/remote/tunnel.ts) applies the very same rules to a session the phone uses. The rules
// themselves did not change. This file has no imports on purpose: the TUI and the server both load it.
//
// Claude Code-style runtime permission modes. The default agent ships "*": "allow", so
// "manual" is enforced by pushing session-level ask rules for sensitive tools:
// session rules are evaluated after agent rules and matching is last-wins, so the most
// recently synced mode decides. "auto" allows every tool, except that the server's
// destructive-action guard (packages/opencode/src/permission/guard.ts) still asks for a
// short list of destructive or hard-to-undo actions (rm -rf outside the project, sudo,
// git push --force, writes outside the project, curl | sh, ...). Both modes carry the
// guard rule: subagents inherit it (not the manual asks), so a subagent stops for
// `rm -rf ~` in either mode. Headless `praex run` is untouched. An agent's own denies (the plan agent's
// edit deny) still hold in both modes: Permission.withSession puts them back after these rules (10-28).

export type PermissionMode = "manual" | "auto"

// write.ts + apply_patch.ts ask as "edit"; shell.ts asks as "bash" (ShellID.ToolID)
const SENSITIVE = ["edit", "bash", "task", "webfetch", "websearch"]
const GUARD = { permission: "destructive", pattern: "*", action: "ask" as const }
// 10-22: read-only shell commands (ls, cat, git status, grep ...) run without asking in manual mode,
// like Claude Code (packages/opencode/src/permission/readonly.ts); the guard still runs after it
const READONLY = { permission: "readonly", pattern: "*", action: "allow" as const }

export const PERMISSION_MODE_RULES = {
  manual: [
    ...SENSITIVE.map((permission) => ({ permission, pattern: "*", action: "ask" as const })),
    READONLY,
    GUARD,
  ],
  auto: [{ permission: "*", pattern: "*", action: "allow" as const }, GUARD],
}

// A stored mode from kv.json: anything but "auto" (missing, old or hand-edited values) is manual.
export function permissionModeOf(value: unknown): PermissionMode {
  return value === "auto" ? "auto" : "manual"
}
