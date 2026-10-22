import { describe, expect, test } from "bun:test"
import { modelLines } from "../../src/cli/cmd/models"
import { BAKED_LINEUP, hostedProvider } from "../../src/plugin/praex-cloud"

describe("praex models lines", () => {
  test("hosted lineup prints id first, then the display name in an aligned column", () => {
    const models = Object.entries(hostedProvider(undefined, BAKED_LINEUP).models).sort(([a], [b]) => a.localeCompare(b))
    expect(modelLines("praex-cloud", models)).toEqual([
      "praex-cloud/faber-ii        Faber II · Pro",
      "praex-cloud/lucia-ii        Lucia II · Max",
      "praex-cloud/velox-ii-baked  Velox III · Free",
    ])
  })

  test("the first field stays the id for scripts", () => {
    const lines = modelLines("test", [["test-model", { name: "Test Model" }]])
    expect(lines).toEqual(["test/test-model  Test Model"])
    expect(lines[0].split(/\s+/)[0]).toBe("test/test-model")
  })

  test("a model without a name, or named after its id, prints the id alone", () => {
    expect(
      modelLines("p", [
        ["a", {}],
        ["bb", { name: "bb" }],
        ["c", { name: "  " }],
        ["d", { name: "Dee" }],
      ]),
    ).toEqual(["p/a", "p/bb", "p/c", "p/d   Dee"])
  })

  test("on a terminal the name is dimmed", () => {
    expect(modelLines("p", [["m", { name: "Em" }]], true)).toEqual(["p/m  \x1b[90mEm\x1b[0m"])
  })
})
