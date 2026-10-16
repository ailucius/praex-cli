// Version of @opencode-ai/plugin installed into config dirs (so local plugins can import it).
// Praex release versions (0.1.x) were never published for the upstream package, so pinning to
// InstallationVersion fails on every launch. Pin to the workspace plugin package this fork is
// built against instead; it tracks the upstream version on merges.
import pkg from "../../../plugin/package.json" with { type: "json" }

export const PluginSDKVersion: string = pkg.version
