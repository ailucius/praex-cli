import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

// Windows code signing goes through Azure Trusted Signing (script/sign-windows.ps1).
// Only run it when the Azure credentials are present in the environment; an unsigned
// build is still a valid build for testers.
async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return
  if (!process.env.AZURE_CLIENT_ID) return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const APP_IDS = {
  dev: "ai.praex.desktop.dev",
  beta: "ai.praex.desktop.beta",
  prod: "ai.praex.desktop",
} as const

// Where electron-updater looks for latest-linux.yml / latest-mac.yml / latest.yml and the
// artifacts they point at. Static files only: praex.ai serves /dl/* straight from GCS.
const UPDATE_URL = "https://praex.ai/dl/desktop"

// macOS notarization needs an Apple API key; without one electron-builder must not try.
const notarize = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)

// Without an Apple certificate the app is signed ad hoc, so the bundle is sealed. A downloaded
// app with no bundle signature at all is reported as "damaged" on Apple Silicon, with no way to
// open it; an ad-hoc one gets the normal "Open Anyway" path in System Settings. Hardened runtime
// only matters for notarization, so it stays off until there is a certificate.
const macCert = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)

// The macOS native helper (packages/desktop/native) is only built on macOS runners.
const nativeDir = path.join(packageDir, "native")

const getBase = (appId: string): Configuration => ({
  artifactName: "praex-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id: "ai.praex.desktop" becomes "ai.praex.desktop.desktop".
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: existsSync(nativeDir)
    ? [
        {
          from: "native/",
          to: "native/",
          filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
        },
      ]
    : [],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    identity: macCert ? undefined : "-",
    hardenedRuntime: macCert,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: false,
  },
  // "praex://" is the app's own scheme. "opencode://" is OpenCode's: claiming it would send
  // OpenCode's links to Praex on machines that have both (old links still parse if passed in).
  protocols: {
    name: "Praex",
    schemes: ["praex"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    // Left off on purpose until there is a Windows code-signing certificate: with it on, unsigned
    // updates would be refused. Turn it on (and pin publisherName) once releases are signed.
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    synopsis: "Praex desktop",
    description: "Praex: a private AI coding assistant with its own models, on your desktop.",
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Praex Dev",
        rpm: { packageName: "praex-desktop-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Praex Beta",
        protocols: { name: "Praex Beta", schemes: ["praex"] },
        publish: { provider: "generic", url: `${UPDATE_URL}/beta`, channel: "latest" },
        rpm: { packageName: "praex-desktop-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Praex",
        publish: { provider: "generic", url: UPDATE_URL, channel: "latest" },
        deb: { packageName: "praex-desktop" },
        rpm: { packageName: "praex-desktop" },
      }
    }
  }
}

export default getConfig()
