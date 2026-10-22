import { describe, expect, test } from "bun:test"
import { SessionTitle } from "../../src/session/title"

describe("session titles describe the task, not the answer (10-22)", () => {
  test("an answer for a title is caught", () => {
    expect(SessionTitle.answered("Tokyo", "Name the capital of Japan in one word.")).toBe(true)
    expect(SessionTitle.answered("51", "What is 17 times 3? Reply with only the number.")).toBe(true)
  })

  test("real titles pass", () => {
    expect(SessionTitle.answered("Capital of Japan", "Name the capital of Japan in one word.")).toBe(false)
    expect(SessionTitle.answered("Multiplying 17 by 3", "What is 17 times 3? Reply with only the number.")).toBe(false)
    expect(SessionTitle.answered("Debugging production errors", "debug 500 errors in production")).toBe(false)
    expect(SessionTitle.answered("Greeting", "hello")).toBe(false)
    expect(SessionTitle.answered("Auth refresh tokens", "@src/auth.ts can you add refresh token support")).toBe(false)
  })

  test("the request becomes the title, shortened at a space", () => {
    expect(SessionTitle.fromRequest("Name the capital of Japan in one word.")).toBe("Name the capital of Japan in one word")
    expect(SessionTitle.fromRequest("can you look at @src/a.ts and explain why the build keeps failing on CI today?")).toBe(
      "Can you look at a.ts and explain why the build",
    )
  })
})
