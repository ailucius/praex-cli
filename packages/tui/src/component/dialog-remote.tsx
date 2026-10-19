import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, type Accessor } from "solid-js"
import { renderUnicodeCompact } from "uqr"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import type { RemoteStatus } from "../app"

export function DialogRemote(props: { status: Accessor<RemoteStatus>; onStop: () => Promise<void> }) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [active, setActive] = createSignal<"done" | "stop">("done")

  const link = createMemo(() => {
    const s = props.status()
    return "link" in s ? s.link : "praex.ai/rc"
  })
  const qr = createMemo(() => renderUnicodeCompact(`https://${link()}`, { border: 2 }).split("\n"))
  const heading = createMemo(() => {
    const s = props.status().state
    if (s === "on") return "Remote Control is on"
    if (s === "reconnecting") return "Remote Control is reconnecting"
    if (s === "connecting") return "Remote Control is connecting"
    return "Remote Control is off"
  })

  const stop = async () => {
    await props.onStop().catch(() => {})
    toast.show({ message: "Remote Control is off.", variant: "info", duration: 3000 })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Run selected Remote Control action",
        group: "Dialog",
        cmd: () => (active() === "stop" ? void stop() : dialog.clear()),
      },
      { key: "left", desc: "Previous action", group: "Dialog", cmd: () => setActive(active() === "done" ? "stop" : "done") },
      { key: "right", desc: "Next action", group: "Dialog", cmd: () => setActive(active() === "done" ? "stop" : "done") },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={props.status().state === "on" ? theme.success : theme.warning}>●</text>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {heading()}
          </text>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>
        Continue this session from your phone or the web. It keeps running here, with your files and tools.
      </text>
      <box alignSelf="flex-start" backgroundColor="#FFFFFF" paddingLeft={2} paddingRight={2}>
        <For each={qr()}>{(line) => <text fg="#000000">{line}</text>}</For>
      </box>
      <box>
        <text fg={theme.text}>
          Open the Sessions tab in the Praex app, or go to <span style={{ fg: theme.primary }}>{link()}</span>.
        </text>
        <text fg={theme.textMuted}>
          Sign in with the same Praex account. This computer only makes outbound connections.
        </text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <For each={["done", "stop"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === active() ? theme.primary : undefined}
              onMouseUp={() => (key === "stop" ? void stop() : dialog.clear())}
            >
              <text fg={key === active() ? theme.selectedListItemText : theme.textMuted}>
                {key === "done" ? "Done" : "Turn off"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
