import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ConfigMarkdown } from "../../src/config/markdown"
import { remoteCommandParts } from "../../src/session/command-mentions"
import { planCommandTemplate } from "../../src/session/command-template"

// 22 Nov (audit 13): which @file mentions of a slash command are attached over Remote Control. No model is needed:
// `resolve` below makes the parts the way SessionPrompt.resolvePromptParts does (a text part, then a file part named
// after each mention whose file exists), with a made-up home folder for "~/".
let base: string
let project: string
let home: string
beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "praex-rc-a13-mentions-")))
  project = path.join(base, "repo", "app")
  home = path.join(base, "home")
  mkdirSync(path.join(project, "src"), { recursive: true })
  mkdirSync(path.join(base, "repo", "docs"), { recursive: true })
  mkdirSync(path.join(home, ".ssh"), { recursive: true })
  mkdirSync(path.join(home, "notes"), { recursive: true })
  writeFileSync(path.join(project, "src", "a.ts"), "export {}\n")
  writeFileSync(path.join(project, "$1"), "a file whose name is a placeholder\n")
  writeFileSync(path.join(base, "repo", "docs", "guide.md"), "guide\n")
  writeFileSync(path.join(home, ".ssh", "id_ed25519"), "secret\n")
  writeFileSync(path.join(home, "notes", "style.md"), "style\n")
  // symlinks inside the project that point out of it: to a folder and to a file
  symlinkSync(path.join(home, ".ssh"), path.join(project, "link"))
  symlinkSync(path.join(home, ".ssh", "id_ed25519"), path.join(project, "src", "key.txt"))
})
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

type Part = { type: "text"; text: string } | { type: "file"; url: string; filename: string; mime: string } | { type: "agent"; name: string }

function resolve(text: string, worktree: string): Part[] {
  const parts: Part[] = [{ type: "text", text }]
  const seen = new Set<string>()
  for (const match of ConfigMarkdown.files(text)) {
    const name = match[1]
    if (!name || seen.has(name)) continue
    seen.add(name)
    const filepath = name.startsWith("~/") ? path.join(home, name.slice(2)) : path.resolve(worktree, name)
    if (!existsSync(filepath)) {
      if (name === "general") parts.push({ type: "agent", name })
      continue
    }
    parts.push({
      type: "file",
      url: pathToFileURL(filepath).href,
      filename: name,
      mime: statSync(filepath).isDirectory() ? "application/x-directory" : "text/plain",
    })
  }
  return parts
}

// A command sent over Remote Control: the template is filled the way the command function fills it, the mentions in
// the final text are resolved, and the filter decides. Returns the real paths of the files still attached.
function attached(template: string, args: string, where?: { directory?: string; worktree?: string }) {
  const directory = where?.directory ?? project
  const worktree = where?.worktree ?? project
  const plan = planCommandTemplate({ template, arguments: args, remote: true })
  if (!plan.ok) throw new Error(plan.message)
  const text = plan.text(plan.shell.map(() => ""))
  const all = resolve(text, worktree)
  const kept = remoteCommandParts({ parts: all, template, context: { directory, worktree, project: {} as any } })
  return {
    text: kept.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    files: kept.flatMap((part) => (part.type === "file" ? [fileURLToPath(part.url)] : [])),
    agents: kept.flatMap((part) => (part.type === "agent" ? [part.name] : [])),
    found: all.flatMap((part) => (part.type === "file" ? [fileURLToPath(part.url)] : [])),
  }
}

describe("remoteCommandParts", () => {
  const secret = () => path.join(home, ".ssh", "id_ed25519")
  const style = () => path.join(home, "notes", "style.md")
  const inside = () => path.join(project, "src", "a.ts")

  test("a mention the command's author wrote is kept, even outside the project", () => {
    const r = attached("Follow @~/notes/style.md and review $ARGUMENTS", "the auth code")
    expect(r.files).toEqual([style()])
    expect(r.text).toEqual(["Follow @~/notes/style.md and review the auth code"])
    // and when the caller names the same file again it is still only that file
    expect(attached("Follow @~/notes/style.md and review $ARGUMENTS", "@~/notes/style.md").files).toEqual([style()])
    // an author mention inside the project, with and without arguments
    expect(attached("Read @src/a.ts first.", "").files).toEqual([inside()])
    expect(attached("Read @src/a.ts first.", "then fix it").files).toEqual([inside()])
  })

  test("a mention in the caller's text that points outside the project is dropped, and stays in the text", () => {
    for (const args of ["@~/.ssh/id_ed25519", `@${secret()}`, "look at @~/.ssh/id_ed25519 please", "@~/notes/style.md", "@../../home/.ssh/id_ed25519"]) {
      for (const template of ["Review the changes.", "Review $ARGUMENTS now.", "Review $1 now."]) {
        const r = attached(template, args)
        expect({ template, args, files: r.files }).toEqual({ template, args, files: [] })
        // the file was found and would have been attached without the filter
        expect({ template, args, found: r.found.length }).toEqual({ template, args, found: 1 })
        expect(r.text).toHaveLength(1)
      }
    }
    expect(attached("Review $ARGUMENTS now.", "@~/.ssh/id_ed25519").text).toEqual(["Review @~/.ssh/id_ed25519 now."])
    // the author's own mention is kept next to a dropped one
    expect(attached("Follow @~/notes/style.md and review $ARGUMENTS", "@~/.ssh/id_ed25519").files).toEqual([style()])
  })

  test("a mention in the caller's text that points into the project is kept", () => {
    expect(attached("Review $ARGUMENTS now.", "@src/a.ts").files).toEqual([inside()])
    expect(attached("Review the changes.", "start with @src/a.ts").files).toEqual([inside()])
    expect(attached("Review $1 now.", `@${inside()}`).files).toEqual([inside()])
    // a folder of the project, and the project folder itself
    expect(attached("Review $ARGUMENTS now.", "@src").files).toEqual([path.join(project, "src")])
    expect(attached("Review $ARGUMENTS now.", `@${project}`).files).toEqual([project])
    // one inside and one outside: only the inside one
    expect(attached("Review $ARGUMENTS now.", "@src/a.ts and @~/.ssh/id_ed25519").files).toEqual([inside()])
  })

  test("a symlink in the project that points outside is dropped", () => {
    for (const args of ["@link/id_ed25519", "@link", "@src/key.txt"]) {
      const r = attached("Review $ARGUMENTS now.", args)
      expect({ args, files: r.files, found: r.found.length }).toEqual({ args, files: [], found: 1 })
    }
  })

  test("a placeholder in a mention is the caller's text once it is filled", () => {
    // "@$1": inside the project it is kept, outside it is dropped
    expect(attached("Look at @$1 closely.", "src/a.ts").files).toEqual([inside()])
    for (const args of ["~/.ssh/id_ed25519", secret(), "link/id_ed25519", "../../home/.ssh/id_ed25519"])
      expect({ args, files: attached("Look at @$1 closely.", args).files }).toEqual({ args, files: [] })
    // "@~/notes/$1": the author wrote the folder, the caller picked the file, so it is not the author's mention
    for (const args of ["style.md", "../.ssh/id_ed25519", "x"])
      expect({ args, files: attached("Use @~/notes/$1 as the guide.", args).files }).toEqual({ args, files: [] })
    // the same file is kept when the author wrote the whole mention
    expect(attached("Use @~/notes/style.md as the guide for $1.", "x").files).toEqual([style()])
    // "$ARGUMENTS" in a mention
    expect(attached("Open @$ARGUMENTS", "~/.ssh/id_ed25519").files).toEqual([])
    expect(attached("Open @$ARGUMENTS", "src/a.ts").files).toEqual([inside()])
    // the caller typing the placeholder itself gets the file of that name in the project, nothing else
    expect(attached("Look at @$1 and $2.", "x @$1").files).toEqual([path.join(project, "$1")])
  })

  test("the text and agent mentions are always kept", () => {
    const r = attached("Ask @general about $ARGUMENTS", "@~/.ssh/id_ed25519 and @src/a.ts")
    expect(r.agents).toEqual(["general"])
    expect(r.files).toEqual([inside()])
    expect(r.text).toEqual(["Ask @general about @~/.ssh/id_ed25519 and @src/a.ts"])
    // parts that are not files pass through untouched, in order
    const parts = [{ type: "text", text: "t" }, { type: "agent", name: "general" }, { type: "subtask" }, { type: "file", url: pathToFileURL(secret()).href, filename: "~/.ssh/id_ed25519" }]
    expect(remoteCommandParts({ parts, template: "t", context: { directory: project, worktree: project, project: {} as any } })).toEqual(parts.slice(0, 3))
    // a file part with no usable url is dropped
    expect(remoteCommandParts({ parts: [{ type: "file" }, { type: "file", url: "data:text/plain;base64,AAAA" }, { type: "file", url: 5 }], template: "t", context: { directory: project, worktree: project, project: {} as any } })).toEqual([])
  })

  test("the worktree counts as the project, but a worktree of / never does", () => {
    const repo = path.join(base, "repo")
    const guide = path.join(repo, "docs", "guide.md")
    // a git project opened in a subfolder: a file elsewhere in the repository is inside the project
    expect(attached("Review $ARGUMENTS now.", "@docs/guide.md", { directory: project, worktree: repo }).files).toEqual([guide])
    expect(attached("Review $ARGUMENTS now.", `@${secret()}`, { directory: project, worktree: repo }).files).toEqual([])
    // a project without git has the worktree "/": every absolute path would be inside it
    expect(attached("Review $ARGUMENTS now.", `@${secret()}`, { directory: project, worktree: "/" }).files).toEqual([])
    expect(attached("Review $ARGUMENTS now.", `@${guide}`, { directory: project, worktree: "/" }).files).toEqual([])
    expect(attached("Review $ARGUMENTS now.", `@${inside()}`, { directory: project, worktree: "/" }).files).toEqual([inside()])
  })

  test("the project folder is compared by its real path", () => {
    // the project reached through a symlink: its own files are still inside, files outside still are not
    const alias = path.join(base, "alias")
    if (!existsSync(alias)) symlinkSync(project, alias)
    expect(attached("Review $ARGUMENTS now.", "@src/a.ts", { directory: alias, worktree: alias }).files).toEqual([path.join(alias, "src", "a.ts")])
    expect(attached("Review $ARGUMENTS now.", "@link/id_ed25519", { directory: alias, worktree: alias }).files).toEqual([])
    expect(attached("Review $ARGUMENTS now.", "@~/.ssh/id_ed25519", { directory: alias, worktree: alias }).files).toEqual([])
  })
})
