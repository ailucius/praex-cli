import { Prompt, type PromptRef } from "../component/prompt"
import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js"
import { RGBA } from "@opentui/core"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTheme } from "../context/theme"
import { useDirectory } from "../context/directory"
import { HomeSessionDestinationProvider, useHomeSessionDestination } from "./home/session-destination"
import { useTerminalDimensions } from "@opentui/solid"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { abbreviateHome } from "../runtime"
import { useTuiPaths } from "../context/runtime"
import { truncatePath } from "../util/status-line"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

// Brand ink stays imperial purple even under the terminal-adaptive "system" theme.
const BRAND = RGBA.fromHex("#a78bfa")
// The mark: a sine wave in a rounded square, drawn with box rules so it stays crisp in any
// terminal font. 7 cells by 3 rows reads close to square at the usual 1:2 cell ratio.
const MARK = ["╭─────╮", "│  ∿  │", "╰─────╯"]
const MARK_WIDTH = 7

// Compact header: mark on the left; product + version, model, and the session's directory
// on the right. The directory is ~-abbreviated and cut to one line, and it is the only place
// the start screen shows it.
function HomeHeader() {
  const pluginRuntime = usePluginRuntime()
  const local = useLocal()
  const sync = useSync()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const destination = useHomeSessionDestination()
  const fallback = useDirectory()
  const version = /^\d/.test(InstallationVersion) ? `v${InstallationVersion}` : InstallationVersion
  const directory = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return fallback()
    const out = abbreviateHome(selected.directory, paths.home)
    const branch = selected.directory === (sync.path.directory || paths.cwd) ? sync.data.vcs?.branch : undefined
    return branch ? `${out}:${branch}` : out
  })
  // 2+2 page padding, the mark, a 2-cell gap.
  const room = createMemo(() => Math.max(12, dimensions().width - 4 - MARK_WIDTH - 2))

  return (
    <box flexDirection="row" gap={2} paddingTop={1} flexShrink={0}>
      <pluginRuntime.Slot name="home_logo" mode="replace">
        <box flexDirection="column" flexShrink={0}>
          <For each={MARK}>
            {(row, index) => (
              <text fg={BRAND} wrapMode="none">
                {index() === 1 ? (
                  <>
                    {"│  "}
                    <span style={{ fg: BRAND, bold: true }}>∿</span>
                    {"  │"}
                  </>
                ) : (
                  row
                )}
              </text>
            )}
          </For>
        </box>
      </pluginRuntime.Slot>
      <box flexDirection="column" minWidth={0} flexShrink={1}>
        <text wrapMode="none">
          <span style={{ fg: BRAND, bold: true }}>Praex</span>
          <span style={{ fg: theme.textMuted }}> {version}</span>
        </text>
        <Show when={local.model.ready} fallback={<text fg={theme.textMuted}> </text>}>
          <text fg={theme.text} wrapMode="none">
            {local.model.parsed().model}
            <span style={{ fg: theme.textMuted }}>
              {local.model.current()?.providerID === "praex-cloud" ? "" : ` · ${local.model.parsed().provider}`}
            </span>
          </text>
        </Show>
        <text fg={theme.textMuted} wrapMode="none">
          {truncatePath(directory(), room())}
        </text>
      </box>
    </box>
  )
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  // Claude-style anatomy: compact header top-left, empty middle, prompt pinned to the
  // bottom, status bar (home_footer) underneath.
  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} paddingLeft={2} paddingRight={2}>
        <HomeHeader />
        <box flexGrow={1} minHeight={0} />
        <pluginRuntime.Slot name="home_bottom" />
        <box width="100%" zIndex={1000} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </pluginRuntime.Slot>
        </box>
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
