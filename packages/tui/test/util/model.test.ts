import { describe, expect, test } from "bun:test"
import { fallbackName, name, parse } from "../../src/util/model"

describe("util.model", () => {
  test("splits provider from a nested model identifier", () => {
    expect(parse("provider/org/model")).toEqual({ providerID: "provider", modelID: "org/model" })
    expect(parse("invalid")).toEqual({ providerID: "invalid", modelID: "" })
  })

  test("a retired Praex model id reads like the lineup's names", () => {
    expect(fallbackName("praex-cloud", "velox-iii")).toBe("Velox III")
    expect(fallbackName("praex-cloud", "velox-ii-baked")).toBe("Velox II")
    expect(fallbackName("praex-cloud", "faber-ii")).toBe("Faber II")
  })

  test("other providers keep their public model ids", () => {
    expect(fallbackName("openai", "gpt-5")).toBe("gpt-5")
    expect(name([], "anthropic", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
  })
})
