import os from "os"
import path from "path"
import { Effect } from "effect"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { InstanceRef } from "@/effect/instance-ref"

// Destructive-action guard. Auto mode allows every tool call, but a short list of actions that
// are destructive or hard to undo still stops for approval. The TUI turns it on by adding a
// rule for the "destructive" permission to the session ({ permission: "destructive",
// pattern: "*", action: "ask" }); a config can set it too, or allow/deny specific commands.
// Without such a rule nothing changes, so headless runs and other clients behave as before.
//
// The checks are deliberately narrow and high confidence: an ordinary command that happens to
// look unusual must keep running in auto mode.

export const ID = "destructive"

export type GuardContext = {
  // Directory the command runs in.
  cwd: string
  // Folders that count as the project (the instance directory and its worktree).
  roots: readonly string[]
  home: string
}

type Word = { text: string; dynamic: boolean }
type Command = Word[]
type Pipeline = Command[]

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const DOWNLOADERS = new Set(["curl", "wget"])
const WRAPPERS = new Set(["env", "nice", "nohup", "time", "command", "builtin", "exec", "stdbuf", "ionice", "timeout"])
const DISK = /^(mkfs(\..+)?|mke2fs|mkswap|wipefs|fdisk|sfdisk|cfdisk|parted|sgdisk)$/

// Splits a POSIX shell command into pipelines of simple commands. Quotes and escapes are
// honoured; command substitutions stay inside their word and mark it dynamic, as does any
// unquoted or double-quoted "$" (its value is unknown here and may be empty).
export function parseShell(input: string): Pipeline[] {
  const pipelines: Pipeline[] = []
  let pipeline: Pipeline = []
  let command: Command = []
  let word: Word | undefined
  const push = () => {
    if (word) command.push(word)
    word = undefined
  }
  const endCommand = () => {
    push()
    if (command.length) pipeline.push(command)
    command = []
  }
  const endPipeline = () => {
    endCommand()
    if (pipeline.length) pipelines.push(pipeline)
    pipeline = []
  }
  const current = () => (word ??= { text: "", dynamic: false })

  // Copies a balanced "$(...)", "<(...)" or backtick span into the current word.
  const nested = (start: number, open: string, close: string) => {
    let depth = 0
    let i = start
    for (; i < input.length; i++) {
      const char = input[i]
      if (char === "\\") {
        i++
        continue
      }
      if (open === close) {
        if (i > start && char === close) break
        continue
      }
      if (char === open) depth++
      else if (char === close) {
        depth--
        if (depth === 0) break
      }
    }
    const w = current()
    w.text += input.slice(start, i + 1)
    w.dynamic = true
    return i
  }

  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    const next = input[i + 1]
    if (char === "\\") {
      if (next === "\n") {
        i++
        continue
      }
      current().text += next ?? ""
      i++
      continue
    }
    if (char === "'") {
      const end = input.indexOf("'", i + 1)
      const stop = end === -1 ? input.length : end
      current().text += input.slice(i + 1, stop)
      i = stop
      continue
    }
    if (char === '"') {
      const w = current()
      let j = i + 1
      for (; j < input.length && input[j] !== '"'; j++) {
        if (input[j] === "\\" && j + 1 < input.length) {
          w.text += input[j + 1]
          j++
          continue
        }
        if (input[j] === "$" && input[j + 1] === "(") {
          w.text += "$"
          j = nested(j + 1, "(", ")")
          continue
        }
        if (input[j] === "`") {
          j = nested(j, "`", "`")
          continue
        }
        if (input[j] === "$") w.dynamic = true
        w.text += input[j]
      }
      i = j
      continue
    }
    if (char === "$" && next === "(") {
      current().text += "$"
      i = nested(i + 1, "(", ")")
      continue
    }
    if ((char === "<" || char === ">") && next === "(") {
      current().text += char
      i = nested(i + 1, "(", ")")
      continue
    }
    if (char === "`") {
      i = nested(i, "`", "`")
      continue
    }
    if (char === "$") {
      current().dynamic = true
      current().text += char
      continue
    }
    if (char === "#" && !word) {
      const end = input.indexOf("\n", i)
      i = end === -1 ? input.length : end - 1
      continue
    }
    if (char === "|") {
      if (next === "|") {
        endPipeline()
        i++
        continue
      }
      endCommand()
      if (next === "&") i++
      continue
    }
    if (char === "&") {
      if (next === "&") i++
      else if (next === ">") {
        // "&>file" redirect: the target is not a command word.
        i++
        push()
        continue
      }
      endPipeline()
      continue
    }
    if (char === ";" || char === "\n" || char === "(" || char === ")" || char === "{" || char === "}") {
      if ((char === "{" || char === "}") && word) {
        current().text += char
        continue
      }
      endPipeline()
      continue
    }
    if (char === ">" || char === "<") {
      // Redirections: skip the operator and its target so they are not read as arguments
      // (a file descriptor number right before it, as in "2>&1", goes too).
      if (word && !word.dynamic && /^\d+$/.test(word.text)) word = undefined
      push()
      let j = i + 1
      while (input[j] === ">" || input[j] === "&" || input[j] === "<") j++
      while (input[j] === " " || input[j] === "\t") j++
      while (j < input.length && !/[\s;&|()]/.test(input[j]!)) j++
      i = j - 1
      continue
    }
    if (char === " " || char === "\t") {
      push()
      continue
    }
    current().text += char
  }
  endPipeline()
  return pipelines
}

// Drops leading "VAR=value" assignments and wrappers like env/nohup/time, and reports sudo.
function unwrap(command: Command): { words: Command; sudo: boolean } {
  let words = command
  let sudo = false
  while (words.length) {
    const head = words[0]!.text
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
      words = words.slice(1)
      continue
    }
    if (head === "sudo" || head === "doas") {
      sudo = true
      words = words.slice(1)
      // sudo's own options ("-u root", "-E").
      while (words.length && words[0]!.text.startsWith("-")) {
        const option = words[0]!.text
        words = words.slice(option === "-u" || option === "-g" ? 2 : 1)
      }
      continue
    }
    if (WRAPPERS.has(head)) {
      words = words.slice(1)
      while (words.length && (words[0]!.text.startsWith("-") || /^\d+[smhd]?$/.test(words[0]!.text)))
        words = words.slice(1)
      continue
    }
    break
  }
  return { words, sudo }
}

function name(word: Word | undefined) {
  if (!word) return ""
  return path.basename(word.text)
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

// Why deleting (or recursively changing) this path needs a look, if it does.
function riskyTarget(word: Word, ctx: GuardContext, verb: "delete" | "change"): string | undefined {
  if (word.dynamic) return `${verb === "delete" ? "Deletes" : "Changes"} a path built from a variable that may be empty`
  const text = expandHome(word.text, ctx.home)
  // A glob deletes what its fixed head names: "build/*" is about build/, "*" about the cwd.
  const glob = text.search(/[*?[]/)
  const head = glob === -1 ? text : text.slice(0, glob)
  const target = path.resolve(ctx.cwd, head || ".")
  const what = verb === "delete" ? "Deletes" : "Changes permissions of"
  if (verb === "delete" && path.basename(path.resolve(ctx.cwd, text)) === ".git")
    return "Deletes a git repository's history (.git)"
  if (target === path.parse(target).root) return `${what} the root of the file system`
  if (inside(ctx.home, target)) return `${what} your home folder or a folder above it`
  if (ctx.roots.some((root) => inside(root, target))) return `${what} the project folder or a folder above it`
  if (target.split(path.sep).filter(Boolean).length <= 1) return `${what} a top-level system folder`
  if (!ctx.roots.some((root) => inside(target, root))) return `${what} files outside the project folder`
  return
}

function flags(words: Command) {
  const short = new Set<string>()
  const long = new Set<string>()
  for (const word of words) {
    const text = word.text
    if (text === "--") break
    if (text.startsWith("--")) long.add(text.split("=")[0]!)
    else if (text.startsWith("-") && text.length > 1) for (const char of text.slice(1)) short.add(char)
  }
  return { short, long }
}

function operands(words: Command) {
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

function checkRm(args: Command, ctx: GuardContext) {
  const { short, long } = flags(args)
  const recursive = short.has("r") || short.has("R") || long.has("--recursive")
  const force = short.has("f") || long.has("--force")
  if (!recursive && !force) return
  for (const target of operands(args)) {
    const reason = riskyTarget(target, ctx, "delete")
    if (reason) return reason
  }
  return
}

function checkGit(args: Command) {
  // Skip global options: "-C dir", "-c key=value", "--git-dir=...".
  let i = 0
  while (i < args.length && args[i]!.text.startsWith("-")) {
    const option = args[i]!.text
    i += option === "-C" || option === "-c" ? 2 : 1
  }
  const sub = args[i]?.text
  const rest = args.slice(i + 1)
  const { short, long } = flags(rest)
  if (sub === "push") {
    const forced =
      short.has("f") ||
      long.has("--force") ||
      long.has("--force-with-lease") ||
      long.has("--force-if-includes") ||
      operands(rest).some((word) => word.text.startsWith("+"))
    if (forced) return "Force-pushes, which can overwrite commits on the remote"
  }
  if (sub === "reset" && long.has("--hard")) return "Discards uncommitted changes (git reset --hard)"
  if (sub === "clean" && (short.has("f") || long.has("--force"))) return "Deletes untracked files (git clean)"
  return
}

function checkChmod(args: Command, ctx: GuardContext) {
  const { short, long } = flags(args)
  if (!short.has("R") && !long.has("--recursive")) return
  // The first operand of chmod is the mode, of chown/chgrp the owner.
  for (const target of operands(args).slice(1)) {
    const reason = riskyTarget(target, ctx, "change")
    if (reason) return `${reason}, recursively`
  }
  return
}

function checkCommand(command: Command, ctx: GuardContext): string | undefined {
  const { words, sudo } = unwrap(command)
  if (sudo) return "Runs a command as root (sudo)"
  const head = name(words[0])
  const args = words.slice(1)
  if (head === "rm") return checkRm(args, ctx)
  if (head === "git") return checkGit(args)
  if (head === "chmod" || head === "chown" || head === "chgrp") return checkChmod(args, ctx)
  if (head === "dd" && args.some((word) => word.text.startsWith("of="))) return "Writes raw data to a file or disk (dd)"
  if (DISK.test(head)) return "Formats or partitions a disk"
  if (SHELLS.has(head) && args.some((word) => /[$<]\((curl|wget)\b|`(curl|wget)\b/.test(word.text)))
    return "Runs a script downloaded from the internet"
  return
}

// Returns a one-line reason when a shell command is destructive or hard to undo.
export function checkShellCommand(input: string, ctx: GuardContext): string | undefined {
  for (const pipeline of parseShell(input)) {
    let downloaded = false
    for (const command of pipeline) {
      const head = name(unwrap(command).words[0])
      if (downloaded && SHELLS.has(head)) return "Runs a script downloaded from the internet"
      if (DOWNLOADERS.has(head)) downloaded = true
      const reason = checkCommand(command, ctx)
      if (reason) return reason
    }
  }
  return
}

// Returns a reason when a file edit or write lands outside the project folder.
export function checkWritePaths(paths: readonly string[], ctx: GuardContext): string | undefined {
  for (const file of paths) {
    const target = path.resolve(ctx.cwd, expandHome(file, ctx.home))
    if (!ctx.roots.some((root) => inside(target, root))) return `Writes outside the project folder (${file})`
  }
  return
}

// The guard's verdict for a permission request: the pattern its rule is matched against and
// the reason shown with the approval prompt.
export function check(
  request: { permission: string; patterns: readonly string[]; metadata?: Record<string, unknown> },
  ctx: GuardContext,
): { pattern: string; reason: string } | undefined {
  const metadata = request.metadata ?? {}
  if (request.permission === "bash") {
    const command = typeof metadata.command === "string" ? metadata.command : request.patterns.join("\n")
    const cwd = typeof metadata.cwd === "string" ? metadata.cwd : ctx.cwd
    const reason = checkShellCommand(command, { ...ctx, cwd })
    return reason ? { pattern: command, reason } : undefined
  }
  if (request.permission === "edit") {
    const files = Array.isArray(metadata.files)
      ? metadata.files.flatMap((file) =>
          file && typeof file === "object" && "filePath" in file && typeof file.filePath === "string"
            ? [file.filePath]
            : [],
        )
      : []
    const paths = files.length ? files : typeof metadata.filepath === "string" ? [metadata.filepath] : []
    const reason = checkWritePaths(paths, ctx)
    return reason ? { pattern: paths.join(", "), reason } : undefined
  }
  return
}

// The guard's decision for a permission request, from the "destructive" rules of the session,
// the config and earlier approvals. Undefined when no such rule exists, the call is not
// flagged, or a rule allows it.
export const evaluate = Effect.fn("Permission.guard")(function* (
  request: { permission: string; patterns: readonly string[]; metadata?: Record<string, unknown> },
  ...rulesets: PermissionV1.Ruleset[]
) {
  const rules = rulesets.flat().filter((rule) => rule.permission === ID)
  if (rules.length === 0) return
  const instance = yield* InstanceRef
  if (!instance) return
  const roots = [instance.directory, ...(instance.worktree && instance.worktree !== "/" ? [instance.worktree] : [])]
  const verdict = check(request, { cwd: instance.directory, roots, home: os.homedir() })
  if (!verdict) return
  const rule = rules.findLast((rule) => Wildcard.match(verdict.pattern, rule.pattern))
  if (!rule || rule.action === "allow") return
  return { action: rule.action, reason: verdict.reason }
})

export * as Guard from "./guard"
