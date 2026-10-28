// 10-28 (Terminal-Bench 2.0, Lucia III 5-try run): `make -j 48` and a parallel opam build ran a task container with a
// memory limit out of memory, and the kernel killed Praex itself (exit 137, 10 trials lost), not the build. On Linux
// every command the agent runs is now the kernel's first choice when memory runs out, so Praex survives, sees the
// failed build and can retry with fewer jobs. Raising a score needs no privileges; Praex's own score is not touched.
import { Shell } from "@opencode-ai/core/shell"

// The group keeps the error quiet where /proc is missing or read-only.
const PREFIX = "{ echo 1000 >/proc/self/oom_score_adj; } 2>/dev/null; "

export function wrap(shell: string, command: string) {
  if (process.platform !== "linux" || !Shell.posix(shell)) return command
  return PREFIX + command
}

// SIGKILL on the command (137) or on something it started (gcc, make and bash say so in the output).
const KILLED = /Killed signal terminated program|\bError 137\b|\d+\s+Killed\s|^Killed$/m

export function killed(code: number | null, output: string) {
  if (process.platform === "win32" || code === 0 || code === null) return false
  return code === 137 || KILLED.test(output)
}

export const KILLED_HINT =
  "The command or a process it started was killed (SIGKILL), which usually means it ran out of memory. Run it again with fewer parallel jobs (for example make -j4 instead of make -j$(nproc)) or on less data at once."
