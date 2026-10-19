import { describe, expect, test } from "bun:test"
import { OPEN_WITH_APPS, planOpenPath, safeExternalUrl } from "./external"

describe("open-link", () => {
  test("web and mail links pass", () => {
    expect(safeExternalUrl("https://praex.ai/download")).toBe("https://praex.ai/download")
    expect(safeExternalUrl("http://localhost:4096/x?y=1")).toBe("http://localhost:4096/x?y=1")
    expect(safeExternalUrl("mailto:davor@praex.ai")).toBe("mailto:davor@praex.ai")
    expect(safeExternalUrl("HTTPS://GitHub.com/ailucius")).toBe("https://github.com/ailucius")
  })

  test("everything else is dropped", () => {
    for (const url of [
      "file:///etc/passwd",
      "file://C:/Windows/System32/calc.exe",
      "smb://host/share",
      "javascript:alert(1)",
      "vbscript:msgbox",
      "ms-msdt:/id",
      "search-ms:query=x",
      "x-apple.systempreferences:com.apple",
      "praex://anything",
      "data:text/html,hi",
      "/relative/path",
      "not a url",
      "",
      undefined,
      42,
      "https://x/" + "a".repeat(9000),
    ])
      expect({ url, out: safeExternalUrl(url) }).toEqual({ url, out: null })
  })
})

describe("open-path", () => {
  const where = async (name: string) => (name === "code" ? "C:\\Program Files\\VS Code\\Code.exe" : null)

  test("no app: the platform default opener, for absolute paths only", async () => {
    expect(await planOpenPath("/home/me/proj", undefined, "linux", where)).toEqual({ kind: "default" })
    expect(await planOpenPath("C:\\proj", "", "win32", where)).toEqual({ kind: "default" })
    expect((await planOpenPath("proj", undefined, "linux", where)).kind).toBe("refused")
    expect((await planOpenPath("--help", undefined, "linux", where)).kind).toBe("refused")
    expect((await planOpenPath(undefined, undefined, "linux", where)).kind).toBe("refused")
  })

  test("allowlisted apps run as before", async () => {
    expect(await planOpenPath("/Users/me/proj", "Visual Studio Code", "darwin", where)).toEqual({
      kind: "exec",
      cmd: "open",
      args: ["-a", "Visual Studio Code", "/Users/me/proj"],
    })
    expect(await planOpenPath("/home/me/proj", "zed", "linux", where)).toEqual({
      kind: "exec",
      cmd: "zed",
      args: ["/home/me/proj"],
    })
    // Windows: resolved in the main process, not taken from the renderer
    expect(await planOpenPath("C:\\proj", "code", "win32", where)).toEqual({
      kind: "exec",
      cmd: "C:\\Program Files\\VS Code\\Code.exe",
      args: ["C:\\proj"],
    })
    // allowlisted but not installed: default opener, as the renderer did before
    expect(await planOpenPath("C:\\proj", "cursor", "win32", where)).toEqual({ kind: "default" })
  })

  test("any other app is refused", async () => {
    for (const [platform, app] of [
      ["linux", "/bin/sh"],
      ["linux", "sh"],
      ["linux", "bash"],
      ["linux", "Terminal"],
      ["darwin", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"],
      ["darwin", "code"],
      ["win32", "cmd.exe"],
      ["win32", "C:\\Windows\\System32\\cmd.exe"],
      ["win32", "C:\\Program Files\\VS Code\\Code.exe"],
      ["freebsd", "code"],
    ] as const)
      expect({ platform, app, plan: await planOpenPath(platform === "win32" ? "C:\\x" : "/tmp/x", app, platform, where) }).toEqual({
        platform,
        app,
        plan: { kind: "refused", reason: "app not allowed" },
      })
    expect((await planOpenPath("/tmp/x", 42, "linux", where)).kind).toBe("refused")
  })

  test("the allowlist matches what the session header offers", () => {
    expect(OPEN_WITH_APPS.linux).toEqual(["code", "cursor", "zed", "Sublime Text"])
    expect(OPEN_WITH_APPS.win32).toContain("powershell")
    expect(OPEN_WITH_APPS.darwin).toContain("Visual Studio Code")
  })
})
