import { describe, expect, test } from "bun:test"
import { partialToolInput } from "../../src/util/partial-json"

describe("partialToolInput", () => {
  test("returns nothing for empty or non-object input", () => {
    expect(partialToolInput(undefined)).toEqual({})
    expect(partialToolInput("")).toEqual({})
    expect(partialToolInput("[1,2")).toEqual({})
  })

  test("parses a complete object", () => {
    expect(partialToolInput('{"description":"Audit folder","subagent_type":"general"}')).toEqual({
      description: "Audit folder",
      subagent_type: "general",
    })
  })

  test("reads the finished fields of a cut-off object", () => {
    expect(partialToolInput('{"description": "Audit folder", "prompt": "Read every fi')).toEqual({
      description: "Audit folder",
    })
  })

  test("leaves out a string that is still streaming", () => {
    expect(partialToolInput('{"filePath":"/tmp/abc')).toEqual({})
    expect(partialToolInput('{"description":')).toEqual({})
    expect(partialToolInput('{"descr')).toEqual({})
    expect(partialToolInput('{"limit": 2')).toEqual({})
  })

  test("unescapes strings", () => {
    expect(partialToolInput('{"command":"echo \\"hi\\"\\nls", "x')).toEqual({ command: 'echo "hi"\nls' })
    expect(partialToolInput('{"command":"caf\\u00e9", "y')).toEqual({ command: "café" })
  })

  test("reads numbers and booleans, and skips nested values", () => {
    expect(partialToolInput('{"limit": 20, "background": true, "todos": [{"a": "}"}], "filePath": "a.ts"')).toEqual({
      limit: 20,
      background: true,
      filePath: "a.ts",
    })
    expect(partialToolInput('{"filePath": "a.ts", "todos": [{"a": 1')).toEqual({ filePath: "a.ts" })
  })
})
