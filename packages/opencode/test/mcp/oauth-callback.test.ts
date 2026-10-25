import { test, expect, describe, afterEach } from "bun:test"
import { McpOAuthCallback } from "../../src/mcp/oauth-callback"
import { parseRedirectUri } from "../../src/mcp/oauth-provider"

describe("parseRedirectUri", () => {
  test("returns defaults when no URI provided", () => {
    const result = parseRedirectUri()
    expect(result.port).toBe(19876)
    expect(result.path).toBe("/mcp/oauth/callback")
  })

  test("parses port and path from URI", () => {
    const result = parseRedirectUri("http://127.0.0.1:8080/oauth/callback")
    expect(result.port).toBe(8080)
    expect(result.path).toBe("/oauth/callback")
  })

  test("returns defaults for invalid URI", () => {
    const result = parseRedirectUri("not-a-valid-url")
    expect(result.port).toBe(19876)
    expect(result.path).toBe("/mcp/oauth/callback")
  })
})

describe("McpOAuthCallback.ensureRunning", () => {
  afterEach(async () => {
    await McpOAuthCallback.stop()
  })

  test("starts server with custom redirectUri port and path", async () => {
    await McpOAuthCallback.ensureRunning("http://127.0.0.1:18000/custom/callback")
    expect(McpOAuthCallback.isRunning()).toBe(true)
  })

  test("escapes the error text it shows on the error page", async () => {
    await McpOAuthCallback.ensureRunning("http://127.0.0.1:18001/custom/callback")
    const url = new URL("http://127.0.0.1:18001/custom/callback")
    url.searchParams.set("state", "any-state")
    url.searchParams.set("error", "access_denied")
    url.searchParams.set("error_description", `<script>alert("x")</script><img src=x onerror='y'>`)
    const res = await fetch(url)
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;y&#39;&gt;")
  })
})
