import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"

type SavedRule = { id: string; permission: string; pattern: string }

function Empty(props: { message: string }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Saved permissions
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted} wrapMode="word">
        {props.message}
      </text>
    </box>
  )
}

// 10-22: "Allow always" rules are saved per project and survive restarts; /permissions lists them and
// removes one (enter, then confirm).
export function usePermissionsDialog() {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const headers = () => ({ "x-opencode-directory": encodeURIComponent(sdk.directory ?? "") })

  const open = async (): Promise<void> => {
    const res = await sdk.fetch(`${sdk.url}/permission/saved`, { headers: headers() }).catch(() => undefined)
    const rules = res?.ok ? ((await res.json()) as SavedRule[]) : undefined
    if (!rules) return dialog.replace(() => <Empty message="Couldn't read the saved permissions." />)
    if (rules.length === 0)
      return dialog.replace(() => (
        <Empty message="Nothing saved for this project. Pick Allow always on a permission prompt to save one. Read-only commands such as ls, cat and git status run without asking in manual mode." />
      ))
    dialog.replace(() => (
      <DialogSelect
        title="Saved permissions · enter removes one"
        options={rules.map((rule) => ({
          title: rule.pattern === "*" ? "anything" : rule.pattern,
          value: rule,
          category: rule.permission,
        }))}
        onSelect={(option) => void remove(option.value)}
      />
    ))
  }

  const remove = async (rule: SavedRule) => {
    const ok = await DialogConfirm.show(
      dialog,
      "Remove saved permission",
      `Praex will ask again before ${rule.permission} ${rule.pattern === "*" ? "anything" : rule.pattern} in this project.`,
    )
    if (ok) {
      const res = await sdk
        .fetch(`${sdk.url}/permission/saved/${encodeURIComponent(rule.id)}`, { method: "DELETE", headers: headers() })
        .catch(() => undefined)
      toast.show(
        res?.ok
          ? { variant: "info", message: `Removed: ${rule.permission} ${rule.pattern}`, duration: 3000 }
          : { variant: "error", message: "Couldn't remove that rule." },
      )
    }
    await open()
  }

  return open
}
