import { describe, expect, test } from "bun:test"
import { nudgeReason } from "../../src/session/nudge"
import { SystemPrompt } from "../../src/session/system"

describe("nudgeReason", () => {
  // Real step endings from the 22 Oct Terminal-Bench run where the turn stopped with the work half done.
  test("an announced action with no tool call gets a nudge", () => {
    expect(nudgeReason("stop", "Now I will run the tests to see what happens:")).toBe("announce")
    expect(nudgeReason("stop", "Still out of range. Let me add debug output to see what's happening:")).toBe("announce")
    expect(nudgeReason("stop", "The build failed on the import.\n\nLet me fix the import path.")).toBe("announce")
    expect(nudgeReason("stop", "Okay, now I'll check the log file...")).toBe("announce")
    expect(nudgeReason("stop", "**Next, I will try a different seed:**")).toBe("announce")
  })

  test("a tool call written as text gets a nudge", () => {
    expect(nudgeReason("stop", "I checked the ratio.\n<image> </function> </tool_call>")).toBe("tool-as-text")
    expect(nudgeReason("stop", '<tool_call>\n{"name": "bash", "arguments": {"command": "ls"}}\n</tool_call>')).toBe(
      "tool-as-text",
    )
  })

  test("a message cut at the output limit gets a nudge", () => {
    expect(nudgeReason("length", "def main():\n    for i in range(")).toBe("cut")
  })

  test("finished answers and questions do not", () => {
    expect(nudgeReason("stop", "Done. All 3 tests pass and the fix is in src/orders.py:13.")).toBeUndefined()
    expect(nudgeReason("stop", "4")).toBeUndefined()
    expect(nudgeReason("stop", "Should I also update the README?")).toBeUndefined()
    expect(nudgeReason("stop", "Let me know if you want the old behaviour back.")).toBeUndefined()
    expect(nudgeReason("stop", "I'll leave the server running on port 8080.")).toBeUndefined()
    expect(nudgeReason("stop", "Here is the fix:\n```python\nx = float(order['amount'])\n```")).toBeUndefined()
    expect(nudgeReason("stop", "")).toBeUndefined()
    expect(nudgeReason("tool-calls", "Let me run the tests:")).toBeUndefined()
    expect(nudgeReason(undefined, "Let me run the tests:")).toBeUndefined()
  })
})

describe("isPraexModel", () => {
  test("Praex model ids", () => {
    for (const id of ["velox-iii", "velox-ii-baked", "faber-ii", "lucia-ii", "Velox"]) expect(SystemPrompt.isPraexModel(id)).toBe(true)
    for (const id of ["qwen3.8-27b", "glm-5.3", "claude-sonnet-5-5", "veloxity", "gpt-5"]) expect(SystemPrompt.isPraexModel(id)).toBe(false)
  })
})
