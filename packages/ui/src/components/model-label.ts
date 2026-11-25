// The model name shown under a message. Sessions keep the model id they ran with, and ids outlive
// lineups: a hosted model gets a new id, a provider is renamed, an old chat still carries the slug.
// A raw id ("velox-iii", "praex/lucia-iii") tells the reader nothing, so resolve it to a display name
// and fall back to the id only when no list knows the model.

type ModelLike = { name?: string } | undefined
type ProviderLike = { models?: Record<string, ModelLike> } | undefined
type Providers = Pick<ReadonlyMap<string, ProviderLike>, "get" | "values">

const HOSTED = "praex-cloud"

// Pickers label a hosted tier "Faber II · Pro". Under a message the plan is noise next to the other items.
const plain = (name: string) => name.replace(/\s+·\s+(free|pro|max)$/i, "")

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const hostedLike = (providerID: string | undefined, modelID: string) =>
  providerID === HOSTED || providerID === "praex" || modelID.startsWith("praex/")

export function modelLabel(providers: Providers | undefined, providerID: string | undefined, modelID: string | undefined) {
  if (!modelID) return ""
  if (!providers) return modelID

  const listed = (provider: ProviderLike, id: string) => {
    const name = provider?.models?.[id]?.name
    return name ? plain(name) : undefined
  }
  const own = providerID ? providers.get(providerID) : undefined
  const direct = listed(own, modelID)
  if (direct) return direct

  // A retired or renamed id: match it to the name its provider (or the hosted lineup) shows today.
  const key = slug(modelID.split("/").at(-1) ?? modelID)
  const byName = (provider: ProviderLike) => {
    for (const model of Object.values(provider?.models ?? {})) {
      if (!model?.name) continue
      const name = plain(model.name)
      if (slug(name) === key) return name
    }
  }
  const renamed = byName(own) ?? (hostedLike(providerID, modelID) ? byName(providers.get(HOSTED)) : undefined)
  if (renamed) return renamed

  // The same id listed by another provider (the session's provider was renamed or removed).
  for (const provider of providers.values()) {
    const name = listed(provider, modelID)
    if (name) return name
  }
  return modelID
}
