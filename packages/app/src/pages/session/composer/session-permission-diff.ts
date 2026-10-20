import type { PermissionRequest } from "@opencode-ai/sdk/v2"

export type PermissionDiffTruncated = { shown: number; total: number }

export type PermissionDiffEntry = {
  file: string
  patch: string
  additions: number
  deletions: number
  truncated?: PermissionDiffTruncated
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function truncated(value: unknown): PermissionDiffTruncated | undefined {
  if (!record(value)) return
  if (typeof value.shown !== "number" || typeof value.total !== "number") return
  return { shown: value.shown, total: value.total }
}

function entry(file: string, patch: string, cut: unknown): PermissionDiffEntry {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { file, patch, additions, deletions, truncated: truncated(cut) }
}

// The proposed change an edit permission request carries: one entry per file for apply_patch
// (`metadata.files`), otherwise the single `metadata.diff` for edit and write.
export function permissionDiffs(request: PermissionRequest): PermissionDiffEntry[] {
  if (request.permission !== "edit") return []
  const metadata = request.metadata ?? {}

  if (Array.isArray(metadata.files)) {
    const files = metadata.files.flatMap((file) => {
      if (!record(file) || typeof file.patch !== "string" || !file.patch.trim()) return []
      const name =
        typeof file.relativePath === "string" ? file.relativePath : typeof file.filePath === "string" ? file.filePath : ""
      if (!name) return []
      return [entry(name, file.patch, file.truncated)]
    })
    if (files.length > 0) return files
  }

  if (typeof metadata.diff !== "string" || !metadata.diff.trim()) return []
  const name = request.patterns[0] ?? (typeof metadata.filepath === "string" ? metadata.filepath : "")
  return [entry(name, metadata.diff, metadata.diffTruncated)]
}
