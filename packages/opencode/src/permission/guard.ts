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
  // set after "cd $DIR" or "cd -": relative paths can then not be resolved
  unknownCwd?: boolean
  // 10-28: the system temp folders. Writing or deleting files INSIDE them is scratch work and does not stop auto mode
  // (founder: auto mode asked for /tmp/praex/validate_config.mjs); the folders themselves stay guarded.
  scratch?: readonly string[]
}

export function scratchDirs(home = os.homedir()): string[] {
  const dirs = process.platform === "win32" ? [os.tmpdir()] : [os.tmpdir(), "/tmp", "/var/tmp"]
  // a TMPDIR set to the file system root, the home folder or a folder above it is not scratch space
  return [...new Set(dirs.map((dir) => path.resolve(dir)))].filter((dir) => dir !== path.parse(dir).root && !inside(home, dir))
}

// Strictly inside a temp folder (the folder itself does not count).
const inScratch = (target: string, ctx: GuardContext) =>
  (ctx.scratch ?? []).some((dir) => target !== dir && inside(target, dir))

// subs: the source of each command substitution ($(...), `...`, <(...)) inside the word, checked as commands
type Word = { text: string; dynamic: boolean; subs?: string[] }
type Command = Word[]
type Pipeline = Command[]

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"])
const DOWNLOADERS = new Set(["curl", "wget"])
const WRAPPERS = new Set(["env", "nice", "nohup", "time", "command", "builtin", "exec", "stdbuf", "ionice", "timeout"])
// wrapper options that take the next word as their value ("env -u NAME", "nice -n 10", "timeout -s KILL")
const WRAPPER_VALUES: Record<string, string[]> = {
  env: ["-u", "-C", "--unset", "--chdir"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-t", "--class", "--classdata"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
}
const ROOT_RUNNERS: Record<string, string> = {
  su: "Runs a command as another user (su)",
  runuser: "Runs a command as another user (runuser)",
  pkexec: "Runs a command as root (pkexec)",
}
// git options that take the next word as their value
const GIT_VALUES = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"])
// find tests that narrow what -delete or -exec rm touches
const FIND_FILTER =
  /^-(i?name|i?path|i?wholename|i?regex|type|xtype|newer\w*|[acm]time|[acm]min|size|empty|user|group|perm|maxdepth|mindepth|prune|links|inum|samefile)$/
const MAX_DEPTH = 6
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
    ;(w.subs ??= []).push(input.slice(start + 1, i))
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
      // "{" and "}" group commands only as separate words ("{ a; }"); "{a,b}" is brace expansion
      if ((char === "{" || char === "}") && (word || (next !== undefined && !/[\s;&|()]/.test(next)))) {
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
    const text = words[0]!.text
    // "/usr/bin/sudo" is sudo
    const head = path.basename(text)
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) {
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
      const values = WRAPPER_VALUES[head] ?? []
      words = words.slice(1)
      while (words.length && (words[0]!.text.startsWith("-") || /^\d+(\.\d+)?[smhd]?$/.test(words[0]!.text)))
        words = words.slice(values.includes(words[0]!.text) ? 2 : 1)
      // "env NAME=value cmd"
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) words = words.slice(1)
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
  // "~name" is another user's home folder, next to ours
  const other = value.match(/^~([A-Za-z0-9._-]+)(\/.*)?$/)
  if (other) return path.join(path.dirname(home), other[1]!, other[2] ?? "")
  return value
}

// "{a,b}x" -> ["ax", "bx"], up to 32 results; words without a comma list stay as they are
function braces(text: string): string[] {
  const match = text.match(/^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/)
  if (!match) return [text]
  return match[2]!
    .split(",")
    .flatMap((part) => braces(match[1]! + part + match[3]!))
    .slice(0, 32)
}

function gitHistory(target: string) {
  // .git/index.lock and other lock files are what a stuck git asks you to remove
  return target.split(path.sep).includes(".git") && !target.endsWith(".lock")
}

function inside(target: string, root: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

// Why deleting (or recursively changing) this path needs a look, if it does.
function riskyTarget(word: Word, ctx: GuardContext, verb: "delete" | "change"): string | undefined {
  if (word.dynamic) return `${verb === "delete" ? "Deletes" : "Changes"} a path built from a variable that may be empty`
  for (const text of braces(word.text)) {
    const reason = riskyPath(text, ctx, verb)
    if (reason) return reason
  }
  return
}

function riskyPath(raw: string, ctx: GuardContext, verb: "delete" | "change"): string | undefined {
  if (ctx.unknownCwd && !path.isAbsolute(raw) && !raw.startsWith("~"))
    return `${verb === "delete" ? "Deletes" : "Changes"} a relative path after a cd to a folder that is not known here`
  const text = expandHome(raw, ctx.home)
  // A glob deletes what its fixed head names: "build/*" is about build/, "*" about the cwd.
  const glob = text.search(/[*?[]/)
  const head = glob === -1 ? text : text.slice(0, glob)
  const target = path.resolve(ctx.cwd, head || ".")
  const what = verb === "delete" ? "Deletes" : "Changes permissions of"
  if (verb === "delete" && gitHistory(path.resolve(ctx.cwd, text))) return "Deletes a git repository's history (.git)"
  if (target === path.parse(target).root) return `${what} the root of the file system`
  if (inside(ctx.home, target)) return `${what} your home folder or a folder above it`
  if (ctx.roots.some((root) => inside(root, target))) return `${what} the project folder or a folder above it`
  if (target.split(path.sep).filter(Boolean).length <= 1) return `${what} a top-level system folder`
  if (inScratch(target, ctx)) return
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
  for (const target of operands(args)) {
    if (recursive) {
      const reason = riskyTarget(target, ctx, "delete")
      if (reason) return reason
      continue
    }
    // Without -r rm deletes files only, never a folder: it needs a look for files outside the project,
    // in .git, or (with -f) a path built from a variable.
    if (target.dynamic) {
      if (force) return "Deletes a path built from a variable that may be empty"
      continue
    }
    for (const text of braces(target.text)) {
      if (ctx.unknownCwd && !path.isAbsolute(text) && !text.startsWith("~"))
        return "Deletes a relative path after a cd to a folder that is not known here"
      const file = path.resolve(ctx.cwd, expandHome(text, ctx.home))
      if (gitHistory(file)) return "Deletes a git repository's history (.git)"
      const glob = file.search(/[*?[]/)
      const folder = path.dirname(glob === -1 ? file : file.slice(0, glob) + "x")
      if (!ctx.roots.some((root) => inside(folder, root))) return "Deletes files outside the project folder"
    }
  }
  return
}

// find ... -delete, find ... -exec rm ...: the starting folders are what can be deleted. A filter
// (-name, -type, -mtime ...) inside the project keeps it ordinary cleanup.
function checkFind(args: Command, ctx: GuardContext, depth: number) {
  let deletes = args.some((word) => word.text === "-delete")
  for (let i = 0; i < args.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i]!.text)) continue
    const end = args.findIndex((word, j) => j > i && (word.text === ";" || word.text === "+"))
    const exec = args.slice(i + 1, end === -1 ? undefined : end)
    if (name(unwrap(exec).words[0]) === "rm") deletes = true
    else {
      const reason = checkCommand(exec, ctx, depth)
      if (reason) return reason
    }
  }
  if (!deletes) return
  const paths: Word[] = []
  let i = 0
  while (i < args.length && /^-([HLP]|D|O\d*)$/.test(args[i]!.text)) i += args[i]!.text === "-D" ? 2 : 1
  if (args[i]?.text === "--") i++
  for (; i < args.length; i++) {
    const text = args[i]!.text
    if (text.startsWith("-") || text === "(" || text === "!") break
    paths.push(args[i]!)
  }
  const filtered = args.some((word) => FIND_FILTER.test(word.text))
  for (const start of paths.length ? paths : [{ text: ".", dynamic: false }]) {
    if (!start.dynamic && filtered && !ctx.unknownCwd) {
      const target = path.resolve(ctx.cwd, expandHome(start.text, ctx.home))
      if (ctx.roots.some((root) => inside(target, root))) continue
    }
    const reason = riskyTarget(start, ctx, "delete")
    if (reason) return `${reason} (find)`
  }
  return
}

// xargs runs a command on words read from its input, so its targets are unknown here.
function checkXargs(args: Command, ctx: GuardContext, depth: number) {
  let i = 0
  while (i < args.length && args[i]!.text.startsWith("-")) {
    const option = args[i]!.text
    i += ["-I", "-i", "-n", "-P", "-L", "-d", "-E", "-s", "-a"].includes(option) ? 2 : 1
  }
  const rest = args.slice(i)
  if (name(unwrap(rest).words[0]) === "rm") {
    const { short, long } = flags(rest.slice(1))
    if (short.has("r") || short.has("R") || long.has("--recursive")) return "Deletes folders read from input (xargs rm -r)"
  }
  return rest.length ? checkCommand(rest, ctx, depth) : undefined
}

function checkGit(args: Command) {
  // Skip global options: "-C dir", "-c key=value", "--git-dir .git", "--git-dir=...".
  let i = 0
  while (i < args.length && args[i]!.text.startsWith("-")) {
    const option = args[i]!.text
    i += GIT_VALUES.has(option) ? 2 : 1
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
    if (short.has("d") || long.has("--delete") || operands(rest).some((word) => /^:./.test(word.text)))
      return "Deletes a branch or tag on the remote (git push --delete)"
  }
  if (sub === "reset" && long.has("--hard")) return "Discards uncommitted changes (git reset --hard)"
  if (sub === "clean" && (short.has("f") || long.has("--force"))) return "Deletes untracked files (git clean)"
  if (
    sub === "branch" &&
    (short.has("D") || ((short.has("d") || long.has("--delete")) && (short.has("f") || long.has("--force"))))
  )
    return "Deletes a branch that may not be merged (git branch -D)"
  if (sub === "checkout") {
    const dashes = rest.findIndex((word) => word.text === "--")
    const discards =
      (dashes !== -1 && dashes < rest.length - 1) ||
      operands(rest).some((word) => word.text === ".") ||
      short.has("f") ||
      long.has("--force")
    if (discards) return "Discards uncommitted changes (git checkout)"
  }
  if (sub === "restore") {
    const staged = short.has("S") || long.has("--staged")
    const worktree = short.has("W") || long.has("--worktree")
    if (!staged || worktree) return "Discards uncommitted changes (git restore)"
  }
  if (sub === "stash" && ["drop", "clear"].includes(rest[0]?.text ?? "")) return "Deletes stashed changes (git stash)"
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

function checkCommand(command: Command, ctx: GuardContext, depth = 0): string | undefined {
  if (depth > MAX_DEPTH) return "Runs commands nested too deeply to check"
  // what runs inside $(...), `...` and <(...) runs too
  for (const word of command)
    for (const sub of word.subs ?? []) {
      const reason = checkShellCommand(sub, ctx, depth + 1)
      if (reason) return reason
    }
  const { words, sudo } = unwrap(command)
  if (sudo) return "Runs a command as root (sudo)"
  const head = name(words[0])
  const args = words.slice(1)
  if (ROOT_RUNNERS[head]) return ROOT_RUNNERS[head]
  // a command given as a string: bash -c "...", eval "...", env -S "..."
  if (SHELLS.has(head)) {
    const flag = args.findIndex((word) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text))
    const script = flag === -1 ? undefined : args[flag + 1]
    if (script) {
      if (script.dynamic && !script.subs) return "Runs a command built from a variable"
      const reason = checkShellCommand(script.text, ctx, depth + 1)
      if (reason) return reason
    }
  }
  if (head === "eval") {
    if (args.some((word) => word.dynamic && !word.subs)) return "Runs a command built from a variable (eval)"
    const reason = checkShellCommand(args.map((word) => word.text).join(" "), ctx, depth + 1)
    if (reason) return reason
  }
  const split = command.findIndex((word) => word.text === "-S" || word.text === "--split-string")
  if (split !== -1 && path.basename(command[0]?.text ?? "") === "env" && command[split + 1]) {
    const reason = checkShellCommand(command[split + 1]!.text, ctx, depth + 1)
    if (reason) return reason
  }
  if (head === "rm") return checkRm(args, ctx)
  if (head === "find") return checkFind(args, ctx, depth + 1)
  if (head === "xargs") return checkXargs(args, ctx, depth + 1)
  if (head === "shred") return "Overwrites files so they cannot be recovered (shred)"
  if (head === "truncate") {
    for (let i = 0; i < args.length; i++) {
      const word = args[i]!
      if (["-s", "-r", "--size", "--reference"].includes(word.text)) {
        i++
        continue
      }
      if (word.text.startsWith("-")) continue
      const target = path.resolve(ctx.cwd, expandHome(word.text, ctx.home))
      if (word.dynamic || !ctx.roots.some((root) => inside(target, root)))
        return "Empties files outside the project folder (truncate)"
    }
  }
  if (head === "mv") {
    const list = operands(args)
    const target = args.some((word) => word.text === "-t" || word.text.startsWith("--target-directory"))
    for (const source of target ? list : list.slice(0, -1)) {
      const reason = riskyTarget(source, ctx, "delete")
      if (reason && !reason.includes("outside the project")) return reason.replace(/^Deletes/, "Moves")
    }
  }
  if (head === "rsync" && args.some((word) => word.text.startsWith("--delete"))) {
    const destination = operands(args).at(-1)
    const reason = destination && !destination.text.includes(":") ? riskyTarget(destination, ctx, "delete") : undefined
    if (reason) return `${reason} (rsync --delete)`
  }
  if (head === "git") return checkGit(args)
  if (head === "chmod" || head === "chown" || head === "chgrp") return checkChmod(args, ctx)
  if (head === "dd" && args.some((word) => word.text.startsWith("of="))) return "Writes raw data to a file or disk (dd)"
  if (DISK.test(head)) return "Formats or partitions a disk"
  if (SHELLS.has(head) && args.some((word) => /[$<]\((curl|wget)\b|`(curl|wget)\b/.test(word.text)))
    return "Runs a script downloaded from the internet"
  return
}

// Returns a one-line reason when a shell command is destructive or hard to undo.
export function checkShellCommand(input: string, context: GuardContext, depth = 0): string | undefined {
  let ctx = context
  for (const pipeline of parseShell(input)) {
    let downloaded = false
    for (const command of pipeline) {
      const { words } = unwrap(command)
      const head = name(words[0])
      if (downloaded && SHELLS.has(head)) return "Runs a script downloaded from the internet"
      if (DOWNLOADERS.has(head)) downloaded = true
      const reason = checkCommand(command, ctx, depth)
      if (reason) return reason
      // "cd ~ && rm -rf Documents": later relative paths start from the new folder
      if (head === "cd" || head === "pushd") {
        const target = operands(words.slice(1))[0]
        if (!target) ctx = { ...ctx, cwd: ctx.home, unknownCwd: false }
        else if (target.dynamic || target.text === "-") ctx = { ...ctx, unknownCwd: true }
        else if (!ctx.unknownCwd || path.isAbsolute(target.text) || target.text.startsWith("~"))
          ctx = { ...ctx, cwd: path.resolve(ctx.cwd, expandHome(target.text, ctx.home)), unknownCwd: false }
      }
    }
  }
  return
}

// Returns a reason when a file edit or write lands outside the project folder.
export function checkWritePaths(paths: readonly string[], ctx: GuardContext): string | undefined {
  for (const file of paths) {
    const target = path.resolve(ctx.cwd, expandHome(file, ctx.home))
    if (inScratch(target, ctx)) continue
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
  const verdict = check(request, { cwd: instance.directory, roots, home: os.homedir(), scratch: scratchDirs() })
  if (!verdict) return
  const rule = rules.findLast((rule) => Wildcard.match(verdict.pattern, rule.pattern))
  if (!rule || rule.action === "allow") return
  return { action: rule.action, reason: verdict.reason }
})

export * as Guard from "./guard"
