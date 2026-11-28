import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { Locale } from "../util/locale"

const BUILTIN: Record<string, string> = {
  build: "Reads, edits and runs commands",
  plan: "Reads and plans, makes no edits",
}

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  // Built-in agents read as "Build" and "Plan" with what they do, not as lower-case ids tagged
  // "native"; custom agents keep the name their config gives them.
  const options = createMemo(() =>
    local.agent.list().map((item) => {
      return {
        value: item.name,
        title: item.native ? Locale.titlecase(item.name) : item.name,
        description: item.native ? (BUILTIN[item.name] ?? item.description) : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title="Agents"
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
