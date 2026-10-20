import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"

// Set at build time when the macOS build is signed with a Developer ID (see electron.vite.config.ts).
export const MAC_SIGNED = import.meta.env.PRAEX_MAC_SIGNED === "1"
