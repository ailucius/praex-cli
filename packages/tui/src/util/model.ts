import type { Provider } from "@opencode-ai/sdk/v2"

export function parse(value: string) {
  const [providerID, ...modelID] = value.split("/")
  return { providerID, modelID: modelID.join("/") }
}

export function index(list: Provider[] | undefined) {
  return new Map((list ?? []).map((item) => [item.id, item] as const))
}

export function get(list: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider =
    list instanceof Map
      ? list.get(providerID)
      : Array.isArray(list)
        ? list.find((item) => item.id === providerID)
        : undefined
  return provider?.models[modelID]
}

export function name(
  list: Provider[] | ReadonlyMap<string, Provider> | undefined,
  providerID: string,
  modelID: string,
) {
  return get(list, providerID, modelID)?.name ?? fallbackName(providerID, modelID)
}

// A session can outlive its model in the hosted lineup (Velox II after Velox III shipped), so
// older turns would print the raw id. Praex ids are "family-generation[-variant]"; spell them
// the way the lineup does. Other providers' ids are their public names and stay as they are.
export function fallbackName(providerID: string, modelID: string) {
  if (providerID !== "praex-cloud") return modelID
  const words = modelID.split("-").filter((word) => word && word !== "baked")
  if (words.length === 0) return modelID
  return words
    .map((word) => (/^[ivx]+$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ")
}
