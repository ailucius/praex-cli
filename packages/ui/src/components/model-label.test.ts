import { describe, expect, test } from "bun:test"
import { modelLabel } from "./model-label"

const providers = new Map([
  [
    "praex-cloud",
    {
      models: {
        "velox-ii-baked": { name: "Velox III · Free" },
        "faber-ii": { name: "Faber II · Pro" },
        "lucia-iii": { name: "Lucia III · Max" },
      },
    },
  ],
  ["openrouter", { models: { "anthropic/claude-sonnet-4.6": { name: "Claude Sonnet 4.6" } } }],
  ["local", { models: { "qwen3-coder:30b": {} } }],
])

describe("modelLabel", () => {
  test("shows the listed name without the plan suffix", () => {
    expect(modelLabel(providers, "praex-cloud", "velox-ii-baked")).toBe("Velox III")
    expect(modelLabel(providers, "praex-cloud", "faber-ii")).toBe("Faber II")
    expect(modelLabel(providers, "openrouter", "anthropic/claude-sonnet-4.6")).toBe("Claude Sonnet 4.6")
  })

  test("resolves a retired hosted id to the name the lineup shows today", () => {
    expect(modelLabel(providers, "praex-cloud", "velox-iii")).toBe("Velox III")
    expect(modelLabel(providers, "praex", "praex/lucia-iii")).toBe("Lucia III")
  })

  test("finds the same id under another provider", () => {
    expect(modelLabel(providers, "openrouter-old", "anthropic/claude-sonnet-4.6")).toBe("Claude Sonnet 4.6")
  })

  test("does not borrow a hosted name for another provider's model", () => {
    expect(modelLabel(providers, "local", "velox-iii")).toBe("velox-iii")
  })

  test("falls back to the id when no list has a name", () => {
    expect(modelLabel(providers, "local", "qwen3-coder:30b")).toBe("qwen3-coder:30b")
    expect(modelLabel(providers, "unknown", "mystery-1")).toBe("mystery-1")
    expect(modelLabel(undefined, "praex-cloud", "velox-iii")).toBe("velox-iii")
    expect(modelLabel(providers, "praex-cloud", undefined)).toBe("")
  })
})
