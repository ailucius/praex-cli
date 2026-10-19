import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"

// Footer items other features push into, e.g. setStatusItem("remote-control", { label: "Remote Control on" }).
// The footer joins every set item with " · " between the permission mode and the context meter,
// so it only ever shows what is true right now. Clear an item with setStatusItem(id, undefined).
export type StatusItem = {
  label: string
  tone?: "muted" | "primary" | "accent" | "success" | "warning" | "error"
  // Lower sorts first; items without an order keep insertion order after ordered ones.
  order?: number
}

const [items, setItems] = createStore<Record<string, StatusItem | undefined>>({})

export function setStatusItem(id: string, item: StatusItem | undefined) {
  setItems(id, item)
}

export function statusItems(): (StatusItem & { id: string })[] {
  return Object.entries(items)
    .flatMap(([id, item]) => (item ? [{ ...item, id }] : []))
    .toSorted((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
}

// Set when the self-updater installed a newer build while this TUI is running. It stays
// visible above the input until restart, instead of a toast that is easy to miss.
const [updated, setUpdated] = createSignal<string>()

export const installedUpdate = updated

export function setInstalledUpdate(version: string) {
  setUpdated(version)
}
