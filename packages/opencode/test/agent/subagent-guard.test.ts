import { expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"

test("a subagent inherits the destructive-action guard, not the parent's other asks", () => {
  const derived = deriveSubagentSessionPermission({
    parentSessionPermission: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "destructive", pattern: "*", action: "ask" },
    ],
    subagent: { permission: [] } as unknown as Agent.Info,
  })
  expect(derived).toContainEqual({ permission: "destructive", pattern: "*", action: "ask" })
  expect(derived).not.toContainEqual({ permission: "bash", pattern: "*", action: "ask" })
})
