// 22 Nov (audit 13): which of a slash command's @file mentions may be attached over Remote Control.
//
// SessionPrompt.command turns every @path in the final command text into a file part (resolvePromptParts), and a
// file part is read on the computer with no permission request. The final text holds the caller's arguments, and
// "@~/..." and absolute paths resolve outside the project, so over Remote Control the phone could attach any file
// the user can read by naming it after a slash command. The tunnel can not see this: the path is in `arguments`,
// not in `parts`. On the computer nothing changes; this filter runs only for a command sent over Remote Control.
//
// A file part is kept when
// (a) its mention is one the command's author wrote: the same name is among the mentions of the template as it
//     was before any argument went in (so "@~/notes/style.md" in a command file still works from the phone, while
//     "@$1" or "@~/notes/$1" filled with the caller's text is not the author's mention any more), or
// (b) the file is inside the project: its real path (symlinks resolved) is inside the instance directory or the
//     worktree, each resolved too. A worktree of "/" (a project without git) is no boundary and is never used.
// Every other part (the text, agent mentions) is kept. A dropped mention stays in the text as typed; the model can
// still ask to read that file with its own tools, which goes through the permission rules.

import { realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigMarkdown } from "@/config/markdown"
import { containsPath, type InstanceContext } from "@/project/instance-context"

// The real path of a file or folder, or its resolved path when it does not exist.
const realOrSelf = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
const isRoot = (p: string) => path.parse(p).root === p

// A command that runs as a subagent hands its whole text to the task tool, which attaches every @path in it. When
// the filter below dropped one of them, SessionPrompt.command refuses the command with this message.
export const REMOTE_SUBTASK_FILE_REFUSED =
  "This command starts a subagent and its text names a file outside this project. Over Remote Control only files in this project's folder can be attached; run it on the computer."

export function remoteCommandParts<T extends { type: string }>(input: {
  /** What resolvePromptParts made of the final command text. */
  parts: readonly T[]
  /** The command's template as its author wrote it, before any argument went in. */
  template: string
  context: InstanceContext
}): T[] {
  const own = new Set(ConfigMarkdown.files(input.template).map((match) => match[1]))
  const worktree = realOrSelf(input.context.worktree)
  // containsPath skips a worktree of "/", so a worktree that is (or resolves to) the root of the disk is handed
  // over as "/" and the instance directory alone decides
  const project: InstanceContext = {
    ...input.context,
    directory: realOrSelf(input.context.directory),
    worktree: isRoot(input.context.worktree) || isRoot(worktree) ? "/" : worktree,
  }
  return input.parts.filter((part) => {
    if (part.type !== "file") return true
    const { url, filename } = part as { url?: unknown; filename?: unknown }
    // resolvePromptParts names a file part after its mention
    if (typeof filename === "string" && own.has(filename)) return true
    if (typeof url !== "string") return false
    let file: string
    try {
      file = fileURLToPath(url)
    } catch {
      return false
    }
    return containsPath(realOrSelf(file), project)
  })
}
