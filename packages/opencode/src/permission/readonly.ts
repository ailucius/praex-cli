import path from "path"
import os from "os"
import { Effect } from "effect"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceRef } from "@/effect/instance-ref"
import { parseShell, type GuardContext } from "./guard"

// 10-22: read-only shell commands run without asking in manual mode, the way Claude Code does it. Even
// `ls` used to stop for approval. A session (the TUI's manual mode) or a config turns it on with an allow
// rule for the "readonly" permission; without one nothing changes. The check is deliberately narrow: a
// command runs unasked only when every part of it is on the list below, reads files inside the project,
// and has no output redirect, command substitution, variable assignment or write-capable flag. Anything
// else asks as before, and the destructive-action guard (./guard) still runs after this.

export const ID = "readonly"

type Word = { text: string; dynamic: boolean }

// Commands that only read. Their path operands must stay inside the project.
const READERS = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "nl",
  "file",
  "stat",
  "du",
  "tree",
  "realpath",
  "readlink",
  "diff",
  "cmp",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "cut",
  "column",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "find",
  "sort",
  "uniq",
])
// Commands with no path operands worth checking (or none at all).
const PLAIN = new Set([
  "pwd",
  "echo",
  "printf",
  "which",
  "type",
  "whoami",
  "date",
  "uname",
  "hostname",
  "basename",
  "dirname",
  "true",
  "false",
  "tr",
  "id",
  "groups",
  "df",
])
const GIT_READ = new Set(["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "blame", "describe", "remote"])
// find actions that run commands, delete or write files.
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"])

// Output redirects (other than to /dev/null or another descriptor), command or process substitution,
// and here-docs make a command more than a read. Quotes are honoured.
function unsafeSyntax(input: string) {
  let quote: string | undefined
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    const next = input[i + 1]
    if (char === "\\" && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else if (quote === '"' && (char === "`" || (char === "$" && next === "("))) return true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "`" || (char === "$" && next === "(")) return true
    if ((char === "<" || char === ">") && next === "(") return true
    if (char === "<" && next === "<") return true
    if (char === ">") {
      // "2>&1", ">&2": duplicating a descriptor writes nothing
      if (next === "&") continue
      let j = i + 1
      while (input[j] === ">" || input[j] === "|") j++
      while (input[j] === " " || input[j] === "\t") j++
      const target = input.slice(j).match(/^[^\s;&|()]+/)?.[0]
      if (target === "/dev/null") continue
      return true
    }
  }
  return false
}

function expandHome(value: string, home: string) {
  if (value === "~") return home
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return value
}

function inside(target: string, root: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

// .env files ask through the read tool too (agent defaults: "*.env" and "*.env.*" ask, .env.example not)
const SECRET = /^\.env(\..+)?$/

function insideProject(word: Word, ctx: GuardContext) {
  if (word.dynamic) return false
  const text = expandHome(word.text, ctx.home)
  const base = path.basename(text)
  if (SECRET.test(base) && base !== ".env.example") return false
  const glob = text.search(/[*?[]/)
  const head = glob === -1 ? text : text.slice(0, glob)
  const target = path.resolve(ctx.cwd, head || ".")
  return ctx.roots.some((root) => inside(target, root))
}

function operands(words: Word[]) {
  const out: Word[] = []
  let done = false
  for (const word of words) {
    if (!done && word.text === "--") {
      done = true
      continue
    }
    if (!done && word.text.startsWith("-") && word.text.length > 1) continue
    out.push(word)
  }
  return out
}

function hasFlag(words: Word[], short: string[], long: string[]) {
  return words.some((word) => {
    const text = word.text
    if (text.startsWith("--")) return long.some((flag) => text === flag || text.startsWith(flag + "="))
    return text.startsWith("-") && short.some((flag) => text.slice(1).includes(flag))
  })
}

function readsOnly(words: Word[], ctx: GuardContext): boolean {
  const head = words[0]
  if (!head || head.dynamic) return false
  // A path ("/bin/rm", "./script") is a different program than its name suggests; only bare names count.
  if (head.text.includes("/")) return false
  const name = head.text
  const args = words.slice(1)

  if (PLAIN.has(name)) {
    if (name === "printf" && args.some((word) => word.text === "-v")) return false
    // `hostname NAME` and `date -s` set them
    if (name === "hostname" && operands(args).length > 0) return false
    if (name === "date" && hasFlag(args, ["s"], ["--set"])) return false
    return true
  }

  if (name === "git") {
    let i = 0
    // "-C dir" inside the project and "--no-pager" are fine; "-c key=value" can run commands (core.pager).
    while (i < args.length && args[i]!.text.startsWith("-")) {
      const option = args[i]!.text
      if (option === "--no-pager") {
        i++
        continue
      }
      if (option === "-C" && args[i + 1] && insideProject(args[i + 1]!, ctx)) {
        i += 2
        continue
      }
      return false
    }
    const sub = args[i]?.text
    if (!sub || !GIT_READ.has(sub)) return false
    const rest = args.slice(i + 1)
    if (rest.some((word) => word.dynamic)) return false
    if (hasFlag(rest, [], ["--output", "--ext-diff"])) return false
    // `git branch NAME` creates a branch; listing and inspecting flags only
    if (sub === "branch") {
      if (hasFlag(rest, ["d", "D", "m", "M", "c", "C", "u", "f"], ["--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description", "--force", "--track"]))
        return false
      const listing = hasFlag(rest, ["l", "a", "r", "v"], ["--list", "--all", "--remotes", "--contains", "--merged", "--no-merged", "--show-current", "--sort", "--format", "--points-at", "--verbose"])
      if (operands(rest).length > 0 && !listing) return false
    }
    // `git remote` lists; `git remote add|remove|set-url ...` changes the config
    if (sub === "remote" && operands(rest).some((word) => !["show", "get-url"].includes(word.text))) return false
    return true
  }

  if (!READERS.has(name)) return false

  if (name === "find") {
    if (args.some((word) => FIND_WRITES.has(word.text))) return false
    // paths come before the first expression
    const paths: Word[] = []
    for (const word of args) {
      if (word.text.startsWith("-") || word.text === "(" || word.text === "!") break
      paths.push(word)
    }
    return paths.every((word) => insideProject(word, ctx))
  }
  if (name === "sort" && hasFlag(args, ["o"], ["--output", "--compress-program"])) return false
  // `uniq IN OUT` writes OUT
  if (name === "uniq" && operands(args).length > 1) return false
  if (name === "rg" && hasFlag(args, [], ["--pre"])) return false
  if (name === "tail" && hasFlag(args, ["f", "F"], ["--follow"])) return false

  // grep and rg take the pattern first unless it comes from -e/-f
  const files = operands(args)
  const patternFirst =
    (name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") &&
    !hasFlag(args, ["e", "f"], ["--regexp", "--file"])
  return (patternFirst ? files.slice(1) : files).every((word) => insideProject(word, ctx))
}

// True when every command in the line only reads (see the list above).
export function readOnlyCommand(input: string, ctx: GuardContext): boolean {
  if (!input.trim() || unsafeSyntax(input)) return false
  const pipelines = parseShell(input)
  if (pipelines.length === 0) return false
  return pipelines.every((pipeline) =>
    pipeline.every((command) => {
      // "VAR=value cmd" can change what cmd does (GIT_PAGER, LD_PRELOAD)
      if (command.some((word, index) => index === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text))) return false
      return readsOnly(command, ctx)
    }),
  )
}

// Whether a bash request runs without asking: a "readonly" allow rule exists, the command reads only and
// it runs inside the project. Undefined (ask as usual) otherwise.
export const evaluate = Effect.fn("Permission.readonly")(function* (
  request: { permission: string; patterns: readonly string[]; metadata?: Record<string, unknown> },
  ...rulesets: PermissionV1.Ruleset[]
) {
  if (request.permission !== "bash") return false
  const rule = rulesets
    .flat()
    .findLast((rule) => rule.permission === ID && Wildcard.match("*", rule.pattern))
  if (!rule || rule.action !== "allow") return false
  const instance = yield* InstanceRef
  if (!instance) return false
  const roots = [instance.directory, ...(instance.worktree && instance.worktree !== "/" ? [instance.worktree] : [])]
  const metadata = request.metadata ?? {}
  const command = typeof metadata.command === "string" ? metadata.command : request.patterns.join("\n")
  const cwd = typeof metadata.cwd === "string" ? metadata.cwd : instance.directory
  if (!roots.some((root) => inside(path.resolve(cwd), root))) return false
  return readOnlyCommand(command, { cwd, roots, home: os.homedir() })
})

export * as ReadOnly from "./readonly"
