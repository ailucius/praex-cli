import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useCommandShortcut } from "../../keymap"

const id = "internal:home-getting-started"

// Shown on the home screen until the user has sent a message in any session; the
// sign-in line stays as long as the hosted Praex account is not connected. Replaces the
// empty space left when the upstream tips were removed (09-03).
const TRY = ["Explain what this project does", "Find and fix a TODO in the codebase", "Write tests for my last change"]

function signedIn(api: TuiPluginApi) {
  const praex = api.state.provider.find((item) => item.id === "praex-cloud")
  return praex?.options?.signedIn === true
}

function View(props: { api: TuiPluginApi; first: boolean; signedIn: boolean }) {
  const theme = () => props.api.theme.current
  const commands = useCommandShortcut("command.palette.show")
  const connect = useCommandShortcut("provider.connect")

  return (
    <box width="100%" maxWidth={90} flexDirection="column" gap={1} paddingBottom={1} flexShrink={1}>
      <Show when={!props.signedIn}>
        <box flexDirection="row">
          <text fg={theme().text} wrapMode="word">
            <span style={{ fg: theme().warning }}>● </span>Not signed in.{" "}
            <span style={{ fg: theme().textMuted }}>
              Run <span style={{ fg: theme().text }}>{connect() || "/connect"}</span> and pick Praex to use Velox II
              for free, or add your own provider keys there.
            </span>
          </text>
        </box>
      </Show>
      <Show when={props.first}>
        <box flexDirection="column" gap={0}>
          <text attributes={TextAttributes.BOLD} fg={theme().text}>
            Getting started
          </text>
          <box flexDirection="column" paddingLeft={2}>
            <For each={TRY}>
              {(item) => (
                <text fg={theme().textMuted}>
                  {"› "}
                  <span style={{ fg: theme().text }}>{item}</span>
                </text>
              )}
            </For>
            <text fg={theme().textMuted} marginTop={1}>
              Praex reads and edits files and runs commands, and asks before each change. Type{" "}
              <span style={{ fg: theme().text }}>@</span> to attach a file,{" "}
              <span style={{ fg: theme().text }}>!</span> to run a shell command
              {commands() ? (
                <>
                  , <span style={{ fg: theme().text }}>{commands()}</span> for every command
                </>
              ) : (
                ""
              )}
              .
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 90,
    slots: {
      home_bottom() {
        // "First" means no message sent in any project: the session count is per project,
        // so remember completion globally once any session exists.
        const first = createMemo(() => {
          if (api.state.session.count() > 0) {
            if (!api.kv.get("getting_started_done", false)) api.kv.set("getting_started_done", true)
            return false
          }
          return !api.kv.get("getting_started_done", false)
        })
        const connected = createMemo(() => signedIn(api))
        const show = createMemo(() => first() || !connected())
        return (
          <Show when={show()}>
            <View api={api} first={first()} signedIn={connected()} />
          </Show>
        )
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
