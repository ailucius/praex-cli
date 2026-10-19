import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "ai.praex.desktop.dev", productName: "Praex Dev" },
  { channel: "beta", appId: "ai.praex.desktop.beta", productName: "Praex Beta" },
  { channel: "prod", appId: "ai.praex.desktop", productName: "Praex" },
] as const

async function load(channel: string, tag: string) {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = channel
  const module = await import(`./electron-builder.config.ts?${tag}=${channel}`)
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous
  return module.default as Configuration
}

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const config = await load(channel.channel, "channel")
    expect(config.appId).toBe(channel.appId)
    expect(config.productName).toBe(channel.productName)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
  })
}

test("prod updates come from praex.ai static files, never GitHub", async () => {
  const config = await load("prod", "publish")
  expect(config.publish).toEqual({ provider: "generic", url: "https://praex.ai/dl/desktop", channel: "latest" })
  expect(config.artifactName).toBe("praex-desktop-${os}-${arch}.${ext}")
  expect(config.protocols).toEqual({ name: "Praex", schemes: ["praex"] })
  expect(config.deb?.fpm).toBeUndefined()
})

test("dev builds never publish", async () => {
  const config = await load("dev", "nopublish")
  expect(config.publish).toBeUndefined()
})
