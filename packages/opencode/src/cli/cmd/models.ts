import { EOL } from "os"
import { Effect } from "effect"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ProviderV2 } from "@opencode-ai/core/provider"

// One model per line, id first so `awk '{print $1}'` still gets the id. The display name follows in
// a column aligned within the provider (dimmed on a terminal); a model whose name is only its id
// prints the id alone.
export function modelLines(providerID: string, models: [string, { name?: string }][], color = false) {
  const width = Math.max(0, ...models.map(([modelID]) => providerID.length + 1 + modelID.length))
  return models.map(([modelID, model]) => {
    const id = `${providerID}/${modelID}`
    const name = typeof model.name === "string" ? model.name.trim() : ""
    if (!name || name === modelID || name === id) return id
    return id.padEnd(width) + "  " + (color ? UI.Style.TEXT_DIM + name + UI.Style.TEXT_NORMAL : name)
  })
}

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs) =>
    yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the model catalogue from praex.ai",
        type: "boolean",
      }),
  handler: Effect.fn("Cli.models")(function* (args) {
    const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
    if (args.refresh) {
      yield* ModelsDev.Service.use((s) => s.refresh(true))
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
    const print = (providerID: ProviderV2.ID, verbose?: boolean) => {
      const p = providers[providerID]
      const sorted = Object.entries(p.models).sort(([a], [b]) => a.localeCompare(b))
      const lines = modelLines(providerID, sorted, color)
      sorted.forEach(([, model], i) => {
        process.stdout.write(lines[i])
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      })
    }

    if (args.provider) {
      const providerID = ProviderV2.ID.make(args.provider)
      if (!providers[providerID]) return yield* fail(`Provider not found: ${args.provider}`)
      print(providerID, args.verbose)
      return
    }

    const ids = Object.keys(providers).sort((a, b) => {
      const aIsPraex = a.startsWith("praex")
      const bIsPraex = b.startsWith("praex")
      if (aIsPraex && !bIsPraex) return -1
      if (!aIsPraex && bIsPraex) return 1
      return a.localeCompare(b)
    })

    for (const providerID of ids) print(ProviderV2.ID.make(providerID), args.verbose)
  }),
})
