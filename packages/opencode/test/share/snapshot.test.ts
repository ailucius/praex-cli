// Fixture keys are split ("sk_" + "live_...") so no literal trips GitHub push protection; all values are fake.
import { describe, expect, test } from "bun:test"
import type * as SDK from "@opencode-ai/sdk/v2"
import { buildSnapshot, displayPath, modelLabel, redact, toolLine, SNAPSHOT_MAX_TEXT } from "@/share/snapshot"

const tool = (name: string, input: Record<string, unknown>, extra: Partial<SDK.ToolPart["state"]> = {}) =>
  ({
    id: "p",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: "c",
    tool: name,
    state: { status: "completed", input, output: "OUTPUT MUST NOT LEAK", title: "", metadata: {}, time: { start: 1, end: 2 }, ...extra },
  }) as SDK.ToolPart

const opts = { directory: "/home/ana/project", home: "/home/ana" }

describe("toolLine", () => {
  test("summarises the common tools in one short line, relative to the project", () => {
    expect(toolLine(tool("read", { filePath: "/home/ana/project/src/a.ts" }), opts)).toBe("Read src/a.ts")
    expect(toolLine(tool("edit", { filePath: "/home/ana/project/src/a.ts", oldString: "x", newString: "y" }), opts)).toBe("Edited src/a.ts")
    expect(toolLine(tool("write", { filePath: "/home/ana/notes.md", content: "secret body" }), opts)).toBe("Wrote ~/notes.md")
    expect(toolLine(tool("bash", { command: "bun test\n  --watch=false" }), opts)).toBe("Ran `bun test --watch=false`")
    expect(toolLine(tool("grep", { pattern: "expires_in" }), opts)).toBe('Searched for "expires_in"')
    expect(toolLine(tool("websearch", { query: "bun 1.4 release" }), opts)).toBe("Searched the web: bun 1.4 release")
    expect(toolLine(tool("todowrite", { todos: [] }), opts)).toBe("Updated the to-do list")
    expect(
      toolLine(tool("apply_patch", { patchText: "*** Begin Patch\n*** Update File: /home/ana/project/a.ts\n*** Add File: b.ts\n*** End Patch" }), opts),
    ).toBe("Edited a.ts, b.ts")
  })

  test("marks failures, never includes output, caps the length", () => {
    const failed = { status: "error", input: { command: "make" }, error: "boom", time: { start: 1, end: 2 } } as any
    expect(toolLine({ ...tool("bash", {}), state: failed })).toBe("Ran `make` (failed)")
    expect(toolLine(tool("read", { filePath: "/x" }))).not.toContain("OUTPUT")
    expect(toolLine(tool("bash", { command: "x".repeat(500) })).length).toBeLessThanOrEqual(160)
  })

  test("redacts secrets in commands", () => {
    expect(toolLine(tool("bash", { command: "export API_TOKEN=abcdef1234567890 && curl -H 'x: sk-" + "ant-api03-abcdefghijklmnopqrstuv'" }))).toBe(
      "Ran `export API_TOKEN=[redacted] && curl -H 'x: [redacted]'`",
    )
  })
})

describe("snapshot helpers", () => {
  test("displayPath keeps project paths relative and hides the home directory", () => {
    expect(displayPath("/home/ana/project/src/x.ts", opts)).toBe("src/x.ts")
    expect(displayPath("/home/ana/.ssh/config", opts)).toBe("~/.ssh/config")
    expect(displayPath("/etc/hosts", opts)).toBe("/etc/hosts")
  })

  test("modelLabel drops the picker's plan suffix", () => {
    expect(modelLabel("Velox II · Free")).toBe("Velox II")
    expect(modelLabel("Faber II · Pro")).toBe("Faber II")
    expect(modelLabel("Gemini 2.5 Pro")).toBe("Gemini 2.5 Pro")
  })

  test("redact covers keys, JWTs and private keys", () => {
    expect(redact("key gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789 ok")).toBe("key [redacted] ok")
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[redacted]")
    expect(redact("Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl")).toBe("Bearer [redacted]")
    expect(redact("plain prose about tokens stays")).toBe("plain prose about tokens stays")
  })

  // 10-20 audit F3: every shape below leaked to a public share link before.
  const cases: [string, string, string][] = [
    ["stripe live", "stripe key sk_" + "live_51Habcdefghijklmnopqrstu", "stripe key [redacted]"],
    ["stripe test", "sk_" + "test_51Habcdefghijklmnopqrstu", "[redacted]"],
    ["stripe restricted", "rk_" + "live_51Habcdefghijklmnopqrstu", "[redacted]"],
    ["bearer header", `curl -H "Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0" https://api.x.com`, `curl -H "Authorization: Bearer [redacted]" https://api.x.com`],
    ["basic header", "Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==", "Authorization: Basic [redacted]"],
    ["npm", "npm token npm" + "_abcdefghijklmnopqrstuvwxyz0123456789", "npm token [redacted]"],
    ["slack webhook", "slack https://hooks.slack" + ".com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX done", "slack [redacted] done"],
    ["github pat", "github" + "_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ", "[redacted]"],
    ["github ghp", "gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789", "[redacted]"],
    ["github gho", "gho_abcdefghijklmnopqrstuvwxyz0123456789", "[redacted]"],
    ["openai", "sk-abcdefghijklmnopqrstuvwxyz012345", "[redacted]"],
    ["openai project", "sk-proj-abcdefghijklmnopqrstuvwxyz_0123-45", "[redacted]"],
    ["anthropic", "sk-" + "ant-api03-abcdefghijklmnopqrstuvwxyz-0123", "[redacted]"],
    ["google", "AI" + "zaSyA1234567890abcdefghijklmnopqrstuv", "[redacted]"],
    ["aws akia", "AKIA" + "IOSFODNN7EXAMPLE", "[redacted]"],
    ["aws asia", "ASIAIOSFODNN7EXAMPLE", "[redacted]"],
    ["aws secret", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws_secret_access_key = [redacted]"],
    ["aws secret json", `"SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"`, `"SecretAccessKey": "[redacted]"`],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "[redacted]"],
    ["env secret", "STRIPE_SECRET=abcdefgh12345678", "STRIPE_SECRET=[redacted]"],
    ["env token", "export GH_TOKEN=abcdefgh12345678", "export GH_TOKEN=[redacted]"],
    ["env password", "DB_PASSWORD='hunter2hunter2'", "DB_PASSWORD='[redacted]'"],
    ["env key", "export OPENAI_KEY=abcdefghijklmnop1234", "export OPENAI_KEY=[redacted]"],
    ["mysql -p", "mysql -u root -pS3cretPassw0rd db", "mysql -u root -p[redacted] db"],
    ["url credentials", "https://user:s3cretpass@example.com/repo.git", "https://[redacted]@example.com/repo.git"],
  ]
  for (const [name, input, expected] of cases) {
    test(`redact: ${name}`, () => {
      expect(redact(input)).toBe(expected)
    })
  }

  test("redact leaves ordinary prose and code alone", () => {
    for (const s of [
      "the monkey: something else entirely",
      "const keyboard = useKeyboard()",
      "Bearer tokens are short lived",
      "mysql -u root -p db",
      "see https://example.com/path for docs",
    ])
      expect(redact(s)).toBe(s)
  })
})

describe("buildSnapshot", () => {
  const user = (text: string, extra: Partial<SDK.TextPart> = {}) =>
    ({ info: { id: "u", role: "user" } as SDK.Message, parts: [{ type: "text", text, ...extra } as SDK.Part] })
  const assistant = (parts: SDK.Part[], info: Partial<SDK.AssistantMessage> = {}) => ({
    info: { id: "a", role: "assistant", ...info } as SDK.Message,
    parts,
  })

  test("keeps role, visible text and tool lines; drops synthetic text, reasoning, summaries", () => {
    const snap = buildSnapshot({
      session: { title: "  Fix   it ", time: { created: 123 } },
      model: "Velox II · Free",
      ...opts,
      messages: [
        { info: { id: "u", role: "user" } as SDK.Message, parts: [
          { type: "text", text: "hello" } as SDK.Part,
          { type: "text", text: "FILE BODY", synthetic: true } as SDK.Part,
          { type: "file", mime: "image/png", filename: "shot.png", url: "data:image/png;base64,AAAA" } as SDK.Part,
        ] },
        assistant([
          { type: "reasoning", text: "PRIVATE THOUGHTS" } as SDK.Part,
          tool("read", { filePath: "/home/ana/project/a.ts" }),
          { type: "text", text: "done" } as SDK.Part,
        ]),
        assistant([{ type: "text", text: "COMPACTION SUMMARY" } as SDK.Part], { summary: true }),
        user("   "),
      ],
    })
    expect(snap).toEqual({
      title: "Fix it",
      model: "Velox II",
      created: 123,
      messages: [
        { role: "user", text: "hello", tools: ["Attached shot.png"] },
        { role: "assistant", text: "done", tools: ["Read a.ts"] },
      ],
    })
    const all = JSON.stringify(snap)
    for (const leak of ["FILE BODY", "PRIVATE THOUGHTS", "COMPACTION SUMMARY", "OUTPUT MUST NOT LEAK", "base64"]) expect(all).not.toContain(leak)
  })

  test("caps long text, many tools and the total size", () => {
    const many = Array.from({ length: 70 }, (_, i) => tool("read", { filePath: `/f${i}` }))
    const snap = buildSnapshot({
      session: { title: "", time: { created: 1 } },
      messages: [user("x".repeat(SNAPSHOT_MAX_TEXT + 500)), assistant(many)],
    })
    expect(snap.title).toBe("Untitled session")
    expect(snap.messages[0].text.length).toBe(SNAPSHOT_MAX_TEXT)
    expect(snap.messages[1].tools).toHaveLength(61)
    expect(snap.messages[1].tools?.at(-1)).toBe("10 more tool calls")

    const huge = Array.from({ length: 200 }, () => user("y".repeat(30_000)))
    const big = buildSnapshot({ session: { title: "big", time: { created: 1 } }, messages: huge })
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(1_900_000)
    expect(big.trimmed).toBe(200 - big.messages.length)
  })

  test("carries the stored id so a re-share updates the same link", () => {
    expect(buildSnapshot({ session: { title: "t", time: { created: 1 } }, messages: [user("hi")], id: "AbCdEfGhIjKlMnOpQrStUv" }).id).toBe(
      "AbCdEfGhIjKlMnOpQrStUv",
    )
  })
})
