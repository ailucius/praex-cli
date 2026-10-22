import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

// 10-22: the Praex account as the TUI sees it. Signed in or not, and the free model's name from the
// live lineup (the gateway names it, "Velox III" today), so sign-in copy never names a retired model.
export const SIGNED_OUT_PREFIX = "Sign in to Praex"

export function freeModelName(models: Record<string, { name: string }> | undefined) {
  const list = Object.values(models ?? {})
  const free = list.find((model) => /·\s*free$/i.test(model.name)) ?? list[0]
  return free?.name.split(" · ")[0] ?? "Velox"
}

export function usePraex() {
  const sync = useSync()
  const provider = createMemo(() => sync.data.provider.find((item) => item.id === "praex-cloud"))
  return {
    signedIn: createMemo(() => provider()?.options?.signedIn === true),
    freeName: createMemo(() => freeModelName(provider()?.models)),
  }
}
