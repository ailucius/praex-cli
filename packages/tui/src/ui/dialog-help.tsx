import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "./dialog"
import { useBindings, useCommandShortcut, useCommandSlashes } from "../keymap"

// Everything here is read from the live keymap and command registry, so the reference can
// only describe keys and slash commands that exist in this build.
const KEYS: { command: string; label: string; fallback?: string }[] = [
  { command: "command.palette.show", label: "All commands" },
  { command: "help.show", label: "This help" },
  { command: "model.list", label: "Choose a model" },
  { command: "agent.cycle", label: "Switch agent (Build / Plan)" },
  { command: "permission.mode.cycle", label: "Permission mode (manual / auto)" },
  { command: "provider.connect", label: "Connect your own provider" },
  { command: "session.new", label: "New session" },
  { command: "session.list", label: "Sessions" },
  { command: "input.newline", label: "New line in the prompt", fallback: "shift+enter" },
  { command: "session.interrupt", label: "Stop the response", fallback: "esc" },
  { command: "prompt.editor", label: "Write the prompt in your editor" },
]

function Section(props: { title: string; children: any }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={0}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      <box flexDirection="column" paddingLeft={2}>
        {props.children}
      </box>
    </box>
  )
}

function Row(props: { k: string; v: string; width: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1}>
      <box width={props.width} flexShrink={0}>
        <text fg={theme.text}>{props.k}</text>
      </box>
      <text fg={theme.textMuted} wrapMode="word" flexShrink={1}>
        {props.v}
      </text>
    </box>
  )
}

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const slashes = useCommandSlashes()
  const shortcuts = KEYS.map((item) => ({ ...item, shortcut: useCommandShortcut(item.command) }))

  const keys = createMemo(() =>
    shortcuts.flatMap((item) => {
      const key = item.shortcut() || item.fallback
      return key ? [{ key, label: item.label }] : []
    }),
  )
  const commands = createMemo(() =>
    slashes()
      .map((entry) => ({ key: entry.display, label: entry.description ?? "" }))
      .filter((entry) => entry.key.startsWith("/"))
      .sort((a, b) => a.key.localeCompare(b.key)),
  )
  const keyWidth = createMemo(() => Math.max(12, ...keys().map((item) => item.key.length)) + 1)
  const cmdWidth = createMemo(() => Math.max(12, ...commands().map((item) => item.key.length)) + 1)

  useBindings(() => ({
    bindings: [
      { key: "return", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
      { key: "escape", desc: "Close help", group: "Dialog", cmd: () => dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Praex help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <scrollbox maxHeight={Math.max(10, dimensions().height - 10)} flexDirection="column">
        <box flexDirection="column" gap={1} paddingBottom={1}>
          <Section title="Keys">
            <For each={keys()}>{(item) => <Row k={item.key} v={item.label} width={keyWidth()} />}</For>
          </Section>

          <Show when={commands().length > 0}>
            <Section title="Slash commands">
              <For each={commands()}>{(item) => <Row k={item.key} v={item.label} width={cmdWidth()} />}</For>
            </Section>
          </Show>

          <Section title="Permissions">
            <text fg={theme.textMuted} wrapMode="word">
              Manual is the default: file edits and shell commands ask first, with Allow once, Allow always or
              Reject. Auto runs tools without asking and shows ⏵⏵ auto in the composer. Switch with /mode.
            </text>
          </Section>

          <Section title="Account and models">
            <Row k="praex login" v="Sign in with Google for the hosted models. No card, no key." width={14} />
            <Row k="Velox II" v="Free with a Praex account." width={14} />
            <Row k="Faber II" v="Praex Pro." width={14} />
            <Row k="Lucia II" v="Praex Max." width={14} />
            <Row k="praex update" v="Update the CLI (patch updates also install themselves)." width={14} />
            <Row k="/connect" v="Bring your own keys: OpenAI, Anthropic, Google, Ollama and more." width={14} />
          </Section>

          <Section title="Config">
            <Row k="~/.config/praex/config.json" v="Global settings (providers, model, MCP servers)." width={30} />
            <Row k="praex.json" v="Per-project settings, in the project root." width={30} />
            <Row k="~/.config/praex/tui.json" v="Keybinds and theme for the TUI." width={30} />
          </Section>
        </box>
      </scrollbox>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
