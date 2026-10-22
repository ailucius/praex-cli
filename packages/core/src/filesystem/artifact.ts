// 10-22: file pickers (the TUI's @, the app's file search) listed __pycache__/*.pyc and other build output
// in a repo without a .gitignore that covers them. find() now skips what no one attaches: caches,
// dependency folders and compiled files. glob and grep (the agent's tools) still see everything the
// .gitignore lets through.
const ARTIFACT_DIRS = new Set([
  "__pycache__",
  "node_modules",
  ".git",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".next",
  ".nuxt",
  ".turbo",
  ".parcel-cache",
])
const ARTIFACT_FILES = /(\.(pyc|pyo|class|o|obj)|^\.DS_Store)$/

export function artifact(relative: string) {
  const parts = relative.replaceAll("\\", "/").split("/").filter(Boolean)
  return parts.some((part) => ARTIFACT_DIRS.has(part)) || ARTIFACT_FILES.test(parts.at(-1) ?? "")
}
