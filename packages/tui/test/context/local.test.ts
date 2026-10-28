import { expect, test } from "bun:test"
import { parseModel, permissionModeOf, recentModels } from "../../src/context/local"

test("parses model IDs containing slashes", () => {
  expect(parseModel("provider/family/model")).toEqual({
    providerID: "provider",
    modelID: "family/model",
  })
})

test("moves a model to the front, deduplicates, and limits recents", () => {
  const recent = Array.from({ length: 12 }, (_, index) => ({
    providerID: "provider",
    modelID: `model-${index}`,
  }))

  expect(recentModels({ providerID: "provider", modelID: "model-5" }, recent)).toEqual([
    { providerID: "provider", modelID: "model-5" },
    ...recent.slice(0, 5),
    ...recent.slice(6, 10),
  ])
})

// 10-28 (founder: "I have automode on and it still asks for permission"): every launch used to start in manual mode.
test("the permission mode is kept between launches, and only an exact 'auto' turns auto on", async () => {
  expect(permissionModeOf("auto")).toBe("auto")
  for (const value of ["manual", undefined, null, "AUTO", "yolo", 1]) expect(permissionModeOf(value)).toBe("manual")
  const src = await Bun.file(new URL("../../src/context/local.tsx", import.meta.url)).text()
  const mode = src.slice(src.indexOf("function createPermissionMode("), src.indexOf("const permission = createPermissionMode()"))
  expect(mode).toContain('kv.signal<string>("permission_mode", "manual")')
  expect(mode).not.toContain('current: "manual"')
})
