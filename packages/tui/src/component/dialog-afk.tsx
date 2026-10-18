import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { renderUnicodeCompact } from "uqr"
import { useTheme } from "../context/theme"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { useBindings } from "../keymap"
import type { AfkInfo } from "../app"

export function DialogAfk(props: { info: AfkInfo; onStop?: () => Promise<void> }) {
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()
  const { theme } = useTheme()
  const [index, setIndex] = createSignal(0)
  const [active, setActive] = createSignal<"copy" | "stop">("copy")

  const url = createMemo(() => props.info.urls[index()] ?? props.info.urls[0] ?? "")
  const qr = createMemo(() => renderUnicodeCompact(url(), { border: 2 }).split("\n"))

  const copy = () =>
    clipboard
      .write?.(url())
      .then(() => toast.show({ message: "AFK URL copied to clipboard", variant: "success" }))
      .catch(() => toast.show({ message: "Failed to copy URL", variant: "error" }))

  const stop = async () => {
    await props.onStop?.().catch(() => {})
    toast.show({ message: "AFK stopped. This session is no longer exposed.", variant: "info", duration: 4000 })
    dialog.clear()
  }

  useBindings(() => ({
    bindings: [
      {
        key: "return",
        desc: "Run selected AFK action",
        group: "Dialog",
        cmd: () => {
          if (active() === "copy") void copy()
          if (active() === "stop") void stop()
        },
      },
      {
        key: "left",
        desc: "Previous AFK action",
        group: "Dialog",
        cmd: () => setActive(active() === "copy" ? "stop" : "copy"),
      },
      {
        key: "right",
        desc: "Next AFK action",
        group: "Dialog",
        cmd: () => setActive(active() === "copy" ? "stop" : "copy"),
      },
      {
        key: "tab",
        desc: "Next AFK address",
        group: "Dialog",
        cmd: () => setIndex((index() + 1) % Math.max(props.info.urls.length, 1)),
      },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <box flexDirection="row" gap={1}>
          <text fg={theme.success}>●</text>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            AFK is now active
          </text>
        </box>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>
        Control this session remotely: prompt, switch models, and approve permissions from your phone or the
        web, like a remote. Scan below (same Wi-Fi or tailnet), then add to home screen.
      </text>
      <box alignSelf="flex-start" backgroundColor="#FFFFFF" paddingLeft={2} paddingRight={2}>
        <For each={qr()}>{(line) => <text fg="#000000">{line}</text>}</For>
      </box>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme.primary}>{url()}</text>
          <Show when={props.info.urls.length > 1}>
            <text fg={theme.textMuted}>
              ({index() + 1}/{props.info.urls.length} · tab to switch)
            </text>
          </Show>
        </box>
        <Show
          when={props.info.password}
          fallback={
            <text fg={theme.error}>
              No server password is set. Anyone who can reach this port controls this machine.
            </text>
          }
        >
          <text fg={theme.textMuted}>
            sign in with user {props.info.username}, password {props.info.password}
          </text>
        </Show>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={1} paddingBottom={1}>
        <For each={["copy", "stop"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === active() ? theme.primary : undefined}
              onMouseUp={() => (key === "copy" ? void copy() : void stop())}
            >
              <text fg={key === active() ? theme.selectedListItemText : theme.textMuted}>
                {key === "copy" ? "Copy URL" : "Stop AFK"}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
