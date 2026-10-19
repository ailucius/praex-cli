import { type Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { type LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { isChatDirectory } from "@/utils/chat-workspace"
import { sessionTitle } from "@/utils/session-title"

type Result = { session: Session; title: string; place?: string }

/** Ctrl/Cmd+K: find a chat or project session by title (searches what the sidebar has loaded). */
export function DialogSearchChats(props: { chatDirectory?: string; projects: LocalProject[] }) {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const serverSync = useServerSync()
  const [query, setQuery] = createSignal("")
  const [active, setActive] = createSignal(0)
  let input: HTMLInputElement | undefined
  let list: HTMLUListElement | undefined

  const all = createMemo(() => {
    const dirs = [
      ...(props.chatDirectory ? [{ dir: props.chatDirectory, place: undefined as string | undefined }] : []),
      ...props.projects
        .filter((p) => p.worktree !== "/" && !isChatDirectory(p.worktree, props.chatDirectory))
        .map((p) => ({ dir: p.worktree, place: p.name || getFilename(p.worktree) })),
    ]
    const out: Result[] = []
    for (const { dir, place } of dirs) {
      const [store] = serverSync().child(dir, { bootstrap: false })
      for (const session of store.session ?? []) {
        if (session.parentID || session.time?.archived) continue
        out.push({ session, title: sessionTitle(session.title) || language.t("sidebar.chat.untitled"), place })
      }
    }
    return out.sort(
      (a, b) => (b.session.time.updated ?? b.session.time.created) - (a.session.time.updated ?? a.session.time.created),
    )
  })
  const results = createMemo(() => {
    const q = query().trim().toLowerCase()
    const items = q ? all().filter((r) => r.title.toLowerCase().includes(q)) : all()
    return items.slice(0, 50)
  })

  const open = (result: Result | undefined) => {
    if (!result) return
    dialog.close()
    navigate(`/${base64Encode(result.session.directory)}/session/${result.session.id}`)
  }
  const move = (delta: number) => {
    const count = results().length
    if (count === 0) return
    setActive((value) => (value + delta + count) % count)
    list?.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" })
  }

  // after the dialog's own focus handling (it focuses its first control, the close button)
  onMount(() => setTimeout(() => input?.focus(), 30))

  return (
    <Dialog title={language.t("search.chats.title")} class="w-[min(560px,92vw)]">
      <div class="flex flex-col gap-2 px-3 pb-3" data-component="search-chats">
        <label class="flex h-10 items-center gap-2 rounded-md bg-background-stronger px-3 shadow-xs-border-base focus-within:shadow-xs-border-focus">
          <Icon name="magnifying-glass" size="small" class="shrink-0 text-icon-weak" />
          <input
            ref={input}
            class="h-full flex-1 bg-transparent text-14-regular text-text-strong outline-none placeholder:text-text-weak"
            placeholder={language.t("search.chats.placeholder")}
            value={query()}
            role="combobox"
            aria-expanded="true"
            aria-controls="search-chats-results"
            aria-activedescendant={results()[active()] ? `search-chat-${active()}` : undefined}
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                move(1)
              }
              if (e.key === "ArrowUp") {
                e.preventDefault()
                move(-1)
              }
              if (e.key === "Enter") {
                e.preventDefault()
                open(results()[active()])
              }
            }}
          />
        </label>
        <Show
          when={results().length > 0}
          fallback={
            <p class="px-2 py-6 text-center text-14-regular text-text-weak">{language.t("search.chats.empty")}</p>
          }
        >
          <ul
            ref={list}
            id="search-chats-results"
            role="listbox"
            class="max-h-[50vh] overflow-y-auto flex flex-col gap-px"
          >
            <For each={results()}>
              {(result, index) => (
                <li
                  id={`search-chat-${index()}`}
                  data-index={index()}
                  role="option"
                  aria-selected={index() === active()}
                  class="flex h-9 cursor-default items-center gap-2 rounded-md px-2 text-14-regular text-text-base"
                  classList={{ "bg-surface-base-active text-text-strong": index() === active() }}
                  onMouseMove={() => setActive(index())}
                  onClick={() => open(result)}
                >
                  <span class="flex-1 truncate">{result.title}</span>
                  <Show when={result.place}>
                    {(place) => (
                      <span class="shrink-0 truncate max-w-[40%] text-12-regular text-text-weak">{place()}</span>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </Dialog>
  )
}
