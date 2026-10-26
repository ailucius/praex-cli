// 10-23 (agent loop): a turn ends when a step makes no tool call. Open models sometimes end a step by only
// announcing the next action ("Now I will run the tests:"), by writing a tool call as plain text that the
// server's parser did not pick up, or by hitting the output limit mid-message. The turn then stops with the
// work half done: 6 of 55 failures in the 22 Oct Terminal-Bench run, one of them after a single step. The
// loop answers such a step with a short hidden user message, at most MAX_NUDGES times per turn.

export const MAX_NUDGES = 3

export type NudgeReason = "announce" | "tool-as-text" | "cut"

export const NUDGE_TEXT: Record<NudgeReason, string> = {
  announce:
    "Continue: carry out the step you just described, using your tools. If the task is already complete, say so in one line.",
  "tool-as-text":
    "Your last message contained a tool call written as plain text, so it did not run. Make the call again with the tool calling format.",
  // 10-23 A/B: most cut steps are a model thinking past the output limit before acting. "Continue" let it
  // keep deliberating until the task timed out; this asks for the next action instead.
  cut: "Your last message hit the output limit before you acted. Do not start the analysis over: take the next concrete step now with a tool call. Write large files in smaller parts.",
}

const ACTION_VERBS =
  "add|apply|build|change|check|clean|compile|configure|confirm|copy|create|debug|delete|download|edit|examine|execute|explore|extract|find|fix|generate|implement|inspect|install|investigate|launch|list|look|make|modify|move|open|patch|print|read|rebuild|refactor|remove|rename|replace|rerun|restart|retry|review|rewrite|run|search|see|set|start|switch|test|try|update|use|verify|view|write"

// "Let me run ...", "Now I'll check ...", "Next, I will try ...". "Let me know ..." is excluded by the verb list.
const ANNOUNCE = new RegExp(
  String.raw`^(?:(?:ok(?:ay)?|now|next|first|then|so|alright|great|good)[,.!]?\s+)*` +
    String.raw`(?:let me|let's|let us|i'll|i will|i'm going to|i am going to|i need to)\s+` +
    String.raw`(?:(?:now|first|also|quickly|then|just|actually)\s+)?(?:${ACTION_VERBS})\b`,
  "i",
)

const TOOL_AS_TEXT = /<\/?tool_call>|<function=[\w.-]+>|<\/function>|<invoke\s+name=|<\|tool_call/i

// 10-24 (audit C10): tool-call markup quoted in a code block or `inline code` is an explanation, not a call.
const withoutCode = (text: string) => text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/`[^`\n]*`/g, " ")

// Why a step that ended the turn should get a nudge, or undefined when it really looks finished.
export function nudgeReason(finish: string | undefined, text: string): NudgeReason | undefined {
  const t = text.trim()
  if (finish === "length") return "cut"
  if (finish !== "stop" || !t) return
  if (TOOL_AS_TEXT.test(withoutCode(t.slice(-4000)))) return "tool-as-text"
  if (t.endsWith("```")) return
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean)
  const last = (lines.at(-1) ?? "").replace(/^[\s>*_#-]+|[\s*_]+$/g, "")
  if (!last || last.endsWith("?")) return
  const sentence = last.split(/(?<=[.!])\s+/).filter(Boolean).at(-1) ?? last
  if (!ANNOUNCE.test(sentence)) return
  // An announcement that ends the message: "Let me run the tests:" or "Now I'll fix the import." (a short
  // last sentence; a long one is usually part of a finished explanation).
  if (/[:…]$|\.\.\.$/.test(last) || sentence.length <= 160) return "announce"
}

// 10-23 (harness gap): in the Terminal-Bench runs our losses against Harbor's reference agent were mostly
// finished-but-wrong answers; that agent asks the model to confirm completion once more before grading. A
// headless run (`praex run`, nobody watching) now gets one hidden check at the end of a turn that used tools.
export const VERIFY_TEXT =
  "Before you finish, check your work against the original request. Re-read it and list each requirement (file paths, names, formats, values, commands the user will run, things that must keep running). Verify each one with your tools against the real files and outputs, and run the code or tests again if you changed anything. Fix whatever does not match. Then reply with a short summary of what you checked."

export const isHeadless = () => process.env.PRAEX_HEADLESS === "1"

// 10-24 (audit C08): the check costs a step and can rewrite a good answer, so it runs only after the turn
// changed something: a file tool, or a shell command that is not plainly read-only.
const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "multiedit", "patch"])
const READ_ONLY = new Set(
  "ls cat head tail less grep egrep fgrep rg wc pwd echo printf which whereis type file stat tree du df printenv date whoami id uname find sed awk sort uniq cut tr diff cmp jq basename dirname realpath readlink true false test [ nl column xxd od hexdump md5sum sha256sum git cd".split(
    " ",
  ),
)
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "blame", "grep", "ls-files", "rev-parse", "describe"])
const FIND_WRITES = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])
// 10-26 (audit R8-11): a read-only command still writes when it is handed an output file, as a flag (sort -o f,
// tree -o f, git diff --output=f) or as a second operand (uniq in out, xxd in out). The commands in NOT_A_FILE use
// these flags for something else (grep -o, find -o, test -o, uname -o, df --output=fields, ...).
const OUTPUT_FLAG = /^(?:--output(?:=|$)|--output-file|-[a-zA-Z]*o)/
const NOT_A_FILE = new Set("grep egrep fgrep rg ls uname od hexdump xxd column df test [ echo printf find".split(" "))
const OUTPUT_OPERAND = new Set(["uniq", "xxd"])
// sed's w and W commands and the w flag of s: sed -n 'w out' in, sed '/x/w out' in, sed 's/a/b/gw out' in.
const SED_WRITE = /(?:^|[\s'";{}\/\d$])[gpiImMe\d]*[wW]\s/

export function changesSomething(tool: string, input: Record<string, unknown> | undefined): boolean {
  if (FILE_TOOLS.has(tool)) return true
  if (tool !== "bash") return false
  const command = typeof input?.command === "string" ? input.command : ""
  const line = command.replace(/\d*>>?\s*\/dev\/null|\d*>&\d/g, " ")
  if (/[>`]|\$\(|<\(/.test(line)) return true
  return line.split(/&&|\|\||[|;&\n]/).some((segment) => {
    const words = segment.trim().split(/\s+/).filter((w) => w && !/^\w+=/.test(w))
    const [name, sub] = words
    if (!name) return false
    if (!READ_ONLY.has(name)) return true
    if (name === "git") return !READ_ONLY_GIT.has(sub ?? "") || words.some((w) => /^--output(=|$)/.test(w))
    if (name === "find") return words.some((w) => FIND_WRITES.has(w))
    if (name === "sed" && words.some((w) => /^(-i|--in-place)/.test(w) || /^-[a-zA-Z]*i/.test(w))) return true
    if (name === "sed" && SED_WRITE.test(segment)) return true
    if (name === "awk" && /system\s*\(|print\s*>|\binplace\b/.test(segment)) return true
    if (!NOT_A_FILE.has(name) && words.slice(1).some((w) => OUTPUT_FLAG.test(w))) return true
    // Operands, leaving out flags, flag values that are numbers (uniq -f 1, xxd -s 0x40) and input redirects.
    const operands = words.slice(1).filter((w) => !/^-.|^<|^[+-]?(?:0x[\da-f]+|\d+)$/i.test(w))
    return OUTPUT_OPERAND.has(name) && operands.length > 1
  })
}
