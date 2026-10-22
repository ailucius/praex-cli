import { describe, expect, test } from "bun:test"
import { chatModel } from "./chat-model"

const caps = (toolcall = true, outText = true) => ({ toolcall, input: { text: true }, output: { text: outText } })
const catalog = (id: string, name: string, capabilities = caps()) => ({ id, name, release_date: "2026-05-01", capabilities })

describe("chatModel", () => {
  test("keeps chat models", () => {
    expect(chatModel("google", catalog("gemini-3.8-flash", "Gemini 3.8 Flash"))).toBe(true)
    expect(chatModel("anthropic", catalog("claude-opus-5-5", "Claude Opus 5.5"))).toBe(true)
    expect(chatModel("openai", catalog("gpt-5.5", "GPT-5.5"))).toBe(true)
  })

  test("hides live, translate, speech, embedding and image models", () => {
    expect(chatModel("google", catalog("gemini-3.5-live-translate-preview", "Gemini 3.5 Live Translate Preview"))).toBe(false)
    expect(chatModel("google", catalog("gemini-3.5-flash-preview-tts", "Gemini 3.5 Flash TTS"))).toBe(false)
    expect(chatModel("google", catalog("gemini-embedding-002", "Gemini Embedding 2"))).toBe(false)
    expect(chatModel("google", catalog("gemini-3.5-flash-image", "Nano Banana 3"))).toBe(false)
    expect(chatModel("openai", catalog("gpt-realtime-2", "GPT Realtime 2"))).toBe(false)
    expect(chatModel("openai", catalog("gpt-4o-audio-preview", "GPT-4o Audio"))).toBe(false)
  })

  test("hides models without tool calls or text output", () => {
    expect(chatModel("openai", catalog("o1-preview", "o1 preview", caps(false)))).toBe(false)
    expect(chatModel("google", catalog("some-model", "Some Model", caps(true, false)))).toBe(false)
  })

  test("Praex models and the user's own config models always stay", () => {
    expect(chatModel("praex-cloud", catalog("velox-live", "Velox Live", caps(false)))).toBe(true)
    expect(chatModel("mock", { id: "audio-test", name: "Audio test" })).toBe(true)
  })
})
