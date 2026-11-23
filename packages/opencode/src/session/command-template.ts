// How a slash command's template becomes the text of a prompt: the caller's arguments are filled into the
// placeholders ($1, $2 ... and $ARGUMENTS), or appended when the template has none, and every !`...` block is
// replaced by the output of that shell command. This file only plans the work (which commands to run, how to put
// the text together); SessionPrompt.command runs the shell commands. No imports, so it is tested without a model.
//
// 22 Nov (audit 13): on the computer the arguments are filled in first and the result is then scanned for shell
// blocks, so arguments holding a !`...` block run a shell command with no permission request. That is the user's
// own keyboard there. Over Remote Control (remote: true) the same route is used by the phone for slash commands, so
// the shell blocks are taken from the command's own template before the caller's text goes in: only blocks the
// command's author wrote are run, and the caller's text is never scanned for one.

const bashRegex = /!`([^`]+)`/g
// Match [Image N] as single token, quoted strings, or non-space sequences
const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g
// Not global on purpose: test() on a global regex remembers where it stopped (lastIndex) between calls.
const anyPlaceholder = /\$\d+/

export const REMOTE_SHELL_ARGUMENTS_REFUSED =
  "This command puts its arguments into a shell command. Over Remote Control it runs only without arguments; run it on the computer."

export type CommandTemplatePlan =
  | { ok: false; message: string }
  | {
      ok: true
      /** The shell commands to run, in order. */
      shell: string[]
      /** The final prompt text, given the output of each shell command in the same order. */
      text: (results: readonly string[]) => string
    }

export function planCommandTemplate(input: { template: string; arguments: string; remote?: boolean }): CommandTemplatePlan {
  const template = input.template
  // Over Remote Control, arguments that are only white space count as none, so nothing of the caller's is used.
  const given = input.remote && input.arguments.trim() === "" ? "" : input.arguments

  const raw = given.match(argsRegex) ?? []
  const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

  const placeholders = template.match(placeholderRegex) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }
  const positional = (text: string) =>
    text.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
  const usesArgumentsPlaceholder = template.includes("$ARGUMENTS")
  const appended = placeholders.length === 0 && !usesArgumentsPlaceholder && !!given.trim()

  // On the computer, and over Remote Control when no arguments were given (nothing of the caller's goes in, so
  // every shell block is the author's): fill first, then find the shell blocks in the result. Unchanged behaviour.
  if (!input.remote || given === "") {
    let filled = positional(template).replaceAll("$ARGUMENTS", given)
    if (appended) filled = filled + "\n\n" + given
    const shell = Array.from(filled.matchAll(bashRegex), (match) => match[1])
    return {
      ok: true,
      shell,
      text: (results) => {
        if (shell.length === 0) return filled.trim()
        let index = 0
        return filled.replace(bashRegex, () => results[index++]).trim()
      },
    }
  }

  // Over Remote Control with arguments: the shell blocks are the ones in the template as its author wrote it.
  const blocks = Array.from(template.matchAll(bashRegex))
  if (blocks.some((match) => match[1].includes("$ARGUMENTS") || anyPlaceholder.test(match[1])))
    return { ok: false, message: REMOTE_SHELL_ARGUMENTS_REFUSED }
  // The text between the blocks; block i sits between outside[i] and outside[i + 1].
  const outside: string[] = []
  let at = 0
  for (const match of blocks) {
    outside.push(template.slice(at, match.index))
    at = match.index + match[0].length
  }
  outside.push(template.slice(at))
  // The arguments go into the text outside the blocks only, as they were typed (a function as the replacement, so
  // "$&" and the like in the caller's text are not read as replacement patterns).
  const texts = outside.map((text) => positional(text).replaceAll("$ARGUMENTS", () => given))
  return {
    ok: true,
    shell: blocks.map((match) => match[1]),
    text: (results) => {
      // shell output is put in after the arguments, so it is never filled or scanned again
      const body = texts.map((text, i) => (i < blocks.length ? text + results[i] : text)).join("")
      return (appended ? body + "\n\n" + given : body).trim()
    },
  }
}
