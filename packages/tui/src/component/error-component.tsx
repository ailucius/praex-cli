import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { getScrollAcceleration } from "../util/scroll"
import { useClipboard } from "../context/clipboard"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useExit } from "../context/exit"

export function ErrorComponent(props: { error: Error; reset: () => void; mode?: "dark" | "light" }) {
  const term = useTerminalDimensions()
  const exit = useExit()
  const clipboard = useClipboard()

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      void exit()
    }
  })
  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/ailucius/praex-cli/issues/new")

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#1a1a1a" : "#eeeeee",
    muted: isLight ? "#8a8a8a" : "#808080",
    primary: isLight ? "#3b7dd8" : "#fab283",
  }

  if (props.error.message) {
    issueURL.searchParams.set("title", `fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("praex-version", InstallationVersion)

  const copyIssueURL = () => {
    void clipboard.write?.(issueURL.toString()).then(() => {
      setCopied(true)
    })
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          Praex hit an unexpected error.
        </text>
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Reset TUI</text>
        </box>
        <box onMouseUp={() => void exit()} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Exit</text>
        </box>
      </box>
      <text fg={colors.text}>{props.error.message}</text>
      <box flexDirection="row" gap={1} alignItems="center">
        <text fg={colors.muted}>Help us fix it:</text>
        <box onMouseUp={copyIssueURL} backgroundColor={colors.primary} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={colors.bg}>
            Copy issue link (error details included)
          </text>
        </box>
        {copied() && <text fg={colors.muted}>Copied</text>}
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)} scrollAcceleration={getScrollAcceleration()}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
    </box>
  )
}
