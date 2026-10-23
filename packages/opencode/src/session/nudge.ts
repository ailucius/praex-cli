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

// Why a step that ended the turn should get a nudge, or undefined when it really looks finished.
export function nudgeReason(finish: string | undefined, text: string): NudgeReason | undefined {
  const t = text.trim()
  if (finish === "length") return "cut"
  if (finish !== "stop" || !t) return
  if (TOOL_AS_TEXT.test(t.slice(-4000))) return "tool-as-text"
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
