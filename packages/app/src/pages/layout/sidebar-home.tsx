import { type Session } from "@opencode-ai/sdk/v2/client"
import { workspaceMode } from "@/utils/workspace-mode"
import { LOW_ALLOWANCE, useAllowanceText, usePraexAccountRefresh } from "@/components/praex-account"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Mark } from "@opencode-ai/ui/logo"
import { Spinner } from "@opencode-ai/ui/spinner"
import { WorkingMark } from "@opencode-ai/ui/working-mark"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { A, useNavigate, useParams } from "@solidjs/router"
import { type Accessor, createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { openPraexSignIn } from "@/components/praex-sign-in-card"
import { type LocalProject, useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"
import { Persist, persisted } from "@/utils/persist"
import { isChatDirectory } from "@/utils/chat-workspace"
import { isPlaceholderTitle, sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import { sortedRootSessions } from "./helpers"

const RECENTS_SHOWN = 10
const PROJECT_SHOWN = 5
const PAGE = 40

const ROW =
  "group/row relative flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-text-base outline-none transition-colors duration-150 hover:bg-surface-raised-base-hover hover:text-text-strong focus-visible:shadow-xs-border-focus"
const ROW_ACTIVE = "bg-surface-base-active text-text-strong hover:bg-surface-base-active"
const SECTION = "flex h-7 items-center justify-between pl-2.5 pr-1 text-12-medium text-text-weaker select-none"
const HINT =
  "shrink-0 text-12-regular text-text-weaker opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100"

export type SidebarHomeProps = {
  mobile?: boolean
  chatDirectory: Accessor<string | undefined>
  projects: Accessor<LocalProject[]>
  newChatKeybind: Accessor<string | undefined>
  searchKeybind: Accessor<string | undefined>
  settingsKeybind: Accessor<string | undefined>
  onNewChat: () => void
  onSearch: () => void
  onOpenFolder: () => void
  onNewProjectSession: (worktree: string) => void
  onCloseProject: (worktree: string) => void
  onOpenSettings: () => void
  onOpenHelp: () => void
  onDownloadApps: () => void
  /** Code mode: open the most recent project (or the folder picker when there is none). */
  onOpenCode: () => void
  /**
   * Code mode, below Projects: sessions from other devices (Remote Control). Owned by the
   * Remote Control work; render nothing until it lands.
   */
  renderRemoteSessions?: () => JSX.Element
}

type SidebarMode = "chat" | "code"

// Pinned chats: a per-device convenience, kept in the app's own storage.
function usePins() {
  const [pins, setPins] = persisted(Persist.global("sidebar.pinned-chats"), createStore({ ids: [] as string[] }))
  const has = (id: string) => pins.ids.includes(id)
  const toggle = (id: string) =>
    setPins("ids", (ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids]))
  return { has, toggle }
}

/** Load a directory's root sessions into its store and keep at least `limit` of them. */
function useSessionList(directory: Accessor<string | undefined>, enabled: Accessor<boolean>, limit: number) {
  const serverSync = useServerSync()
  const [loading, setLoading] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 60_000)
  onCleanup(() => clearInterval(timer))

  const store = createMemo(() => {
    const dir = directory()
    if (!dir || !enabled()) return
    const [value, set] = serverSync().child(dir)
    return { dir, value, set }
  })
  createEffect(
    on(
      () => store()?.dir,
      (dir) => {
        const item = store()
        if (!dir || !item) return
        if ((item.value.limit ?? 0) < limit) item.set("limit", limit)
        setLoading(true)
        void serverSync()
          .project.loadSessions(dir)
          .catch(() => {})
          .finally(() => setLoading(false))
      },
    ),
  )
  const sessions = createMemo(() => {
    const item = store()
    if (!item) return [] as Session[]
    return sortedRootSessions(item.value, now())
  })
  const hasMore = createMemo(() => (store()?.value.sessionTotal ?? 0) > sessions().length)
  const loadMore = () => {
    const item = store()
    if (!item) return
    item.set("limit", (value) => (value ?? 0) + PAGE)
    void serverSync().project.loadSessions(item.dir)
  }
  return { sessions, loading, hasMore, loadMore }
}

function usePraexAccount() {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const dialog = useDialog()
  const language = useLanguage()
  const provider = createMemo(() => serverSync().data.provider.all.get("praex-cloud"))
  const signedIn = createMemo(() => (provider()?.options as Record<string, unknown> | undefined)?.signedIn === true)
  const signIn = () => openPraexSignIn(dialog)
  const signOut = async () => {
    await serverSDK()
      .client.auth.remove({ providerID: "praex-cloud" })
      .then(() => serverSDK().client.global.dispose())
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: err instanceof Error ? err.message : String(err),
        })
      })
  }
  // 10-22: email, plan and today's allowance under the account button (it said only "Signed in")
  const info = usePraexAccountRefresh()
  const text = useAllowanceText()
  const detail = createMemo(() => {
    const value = info.account()
    if (!signedIn() || !value?.signedIn) return undefined
    return {
      name: value.email,
      line:
        value.left !== undefined && value.left < LOW_ALLOWANCE
          ? `${text.plan(value.plan)} · ${text.short(value.left)}`
          : text.plan(value.plan),
      low: value.left !== undefined && value.left < LOW_ALLOWANCE,
    }
  })
  return { available: () => !!provider(), signedIn, signIn, signOut, detail }
}

/**
 * The sidebar: app menu, New chat, Search, Projects (folders with their chats nested)
 * and Recents (plain chats in the private chat workspace, newest first), account at the bottom.
 */
export function SidebarHome(props: SidebarHomeProps) {
  const language = useLanguage()
  const params = useParams()
  const account = usePraexAccount()

  const currentDir = createMemo(() => (params.dir ? (decode64(params.dir) ?? "") : ""))
  const inChat = createMemo(() => isChatDirectory(currentDir(), props.chatDirectory()))
  const onNewChatRoute = createMemo(() => inChat() && !params.id)

  // the chat workspace is never a project, and neither is the filesystem root
  const projects = createMemo(() =>
    props
      .projects()
      .filter((project) => project.worktree !== "/" && !isChatDirectory(project.worktree, props.chatDirectory())),
  )

  const pins = usePins()
  const mode = workspaceMode.get
  const setMode = workspaceMode.set
  // the route decides the mode: a project means Code, the chat workspace means Chat. Re-derived on
  // every navigation (not only a folder change), so opening a chat after a Code click shows Chat.
  createEffect(
    on([currentDir, () => params.id], ([dir]) => {
      if (!dir) return
      setMode(inChat() ? "chat" : "code")
    }),
  )
  const switchMode = (next: SidebarMode) => {
    if (next === mode()) return
    setMode(next)
    if (next === "chat") props.onNewChat()
    else props.onOpenCode()
  }

  const recents = useSessionList(props.chatDirectory, () => true, PAGE)
  const pinned = createMemo(() => recents.sessions().filter((session) => pins.has(session.id)))
  const unpinned = createMemo(() => recents.sessions().filter((session) => !pins.has(session.id)))
  const [recentsExpanded, setRecentsExpanded] = createSignal(false)
  const shownRecents = createMemo(() => (recentsExpanded() ? unpinned() : unpinned().slice(0, RECENTS_SHOWN)))
  const recentsHaveMore = createMemo(
    () => (!recentsExpanded() && unpinned().length > RECENTS_SHOWN) || (recentsExpanded() && recents.hasMore()),
  )

  const accountMenu = (placement: "bottom" | "top") => (
    <DropdownMenu.Portal>
      <DropdownMenu.Content class={placement === "bottom" ? "mt-1 min-w-[220px]" : "mb-1 min-w-[220px]"}>
        <DropdownMenu.Item onSelect={props.onOpenSettings}>
          <DropdownMenu.ItemLabel>{language.t("sidebar.settings")}</DropdownMenu.ItemLabel>
        </DropdownMenu.Item>
        <DropdownMenu.Item onSelect={props.onOpenHelp}>
          <DropdownMenu.ItemLabel>{language.t("sidebar.account.help")}</DropdownMenu.ItemLabel>
        </DropdownMenu.Item>
        <DropdownMenu.Item onSelect={props.onDownloadApps}>
          <DropdownMenu.ItemLabel>{language.t("sidebar.account.download")}</DropdownMenu.ItemLabel>
        </DropdownMenu.Item>
        <Show when={account.available()}>
          <DropdownMenu.Separator />
          <Show
            when={account.signedIn()}
            fallback={
              <DropdownMenu.Item onSelect={account.signIn}>
                <DropdownMenu.ItemLabel>{language.t("praex.signin.action")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            }
          >
            <DropdownMenu.Item onSelect={() => void account.signOut()}>
              <DropdownMenu.ItemLabel>{language.t("sidebar.account.signOut")}</DropdownMenu.ItemLabel>
            </DropdownMenu.Item>
          </Show>
        </Show>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )

  return (
    <div
      data-component="sidebar-home"
      class="flex h-full w-full min-w-0 flex-col bg-background-base"
      classList={{ "border-r border-border-weaker-base": !props.mobile }}
    >
      <div class="shrink-0 flex items-center justify-between gap-2 px-2 pt-2">
        <DropdownMenu>
          <DropdownMenu.Trigger
            as="button"
            type="button"
            data-action="app-menu"
            class="flex h-9 max-w-full items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-surface-raised-base-hover focus-visible:shadow-xs-border-focus data-[expanded]:bg-surface-base-active"
            aria-label={language.t("sidebar.account.menu")}
          >
            <Mark class="w-5 shrink-0" />
            <span class="truncate text-14-medium text-text-strong">Praex</span>
            <Icon name="chevron-down" size="small" class="shrink-0 text-icon-weak" />
          </DropdownMenu.Trigger>
          {accountMenu("bottom")}
        </DropdownMenu>
        <div
          role="radiogroup"
          aria-label={language.t("sidebar.mode.label")}
          data-component="sidebar-mode-switch"
          class="flex h-7 shrink-0 items-center rounded-lg bg-surface-base p-0.5"
        >
          <For each={["chat", "code"] as const}>
            {(value) => (
              <button
                type="button"
                role="radio"
                aria-checked={mode() === value}
                data-action={`sidebar-mode-${value}`}
                class="h-6 rounded-md px-2.5 text-12-medium outline-none transition-colors duration-150 focus-visible:shadow-xs-border-focus"
                classList={{
                  "bg-surface-raised-stronger-non-alpha text-text-strong shadow-xs-border-base": mode() === value,
                  "text-text-weak hover:text-text-base": mode() !== value,
                }}
                onClick={() => switchMode(value)}
              >
                {language.t(value === "chat" ? "sidebar.mode.chat" : "sidebar.mode.code")}
              </button>
            )}
          </For>
        </div>
      </div>

      <div class="shrink-0 flex flex-col gap-px px-2 pt-2 pb-1">
        <button
          type="button"
          data-action="chat-new"
          class={`${ROW} ${mode() === "chat" && onNewChatRoute() ? ROW_ACTIVE : ""}`}
          onClick={() => (mode() === "chat" ? props.onNewChat() : props.onOpenCode())}
        >
          <Icon name="new-session" size="small" class="shrink-0 text-icon-base" />
          <span class="flex-1 truncate">{language.t(mode() === "chat" ? "sidebar.chat.new" : "sidebar.code.new")}</span>
          <Show when={!props.mobile && mode() === "chat" && props.newChatKeybind()}>
            {(keybind) => <span class={HINT}>{keybind()}</span>}
          </Show>
        </button>
        <button type="button" data-action="chat-search" class={ROW} onClick={props.onSearch}>
          <Icon name="magnifying-glass" size="small" class="shrink-0 text-icon-base" />
          <span class="flex-1 truncate">{language.t("sidebar.search")}</span>
          <Show when={!props.mobile && props.searchKeybind()}>
            {(keybind) => <span class={HINT}>{keybind()}</span>}
          </Show>
        </button>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-3 [scrollbar-gutter:stable]">
        <Show
          when={mode() === "code"}
          fallback={
            <>
              <Show when={pinned().length > 0}>
                <section aria-labelledby="sidebar-pinned-label" class="pt-3">
                  <div class={SECTION}>
                    <h2 id="sidebar-pinned-label" class="text-12-medium">
                      {language.t("sidebar.pinned")}
                    </h2>
                  </div>
                  <ul class="flex flex-col gap-px">
                    <For each={pinned()}>
                      {(session) => <SessionRow session={session} pinned onTogglePin={() => pins.toggle(session.id)} />}
                    </For>
                  </ul>
                </section>
              </Show>
              <section aria-labelledby="sidebar-recents-label" class="pt-3">
                <div class={SECTION}>
                  <h2 id="sidebar-recents-label" class="text-12-medium">
                    {language.t("sidebar.recents")}
                  </h2>
                </div>
                <Show
                  when={unpinned().length > 0}
                  fallback={
                    <Show
                      when={!recents.loading()}
                      fallback={
                        <div class="flex h-8 items-center gap-2 px-2 text-12-regular text-text-weak" aria-live="polite">
                          <Spinner class="size-3" />
                          {language.t("sidebar.chats.loading")}
                        </div>
                      }
                    >
                      <p class="px-2 text-12-regular text-text-weak">{language.t("sidebar.chats.empty")}</p>
                    </Show>
                  }
                >
                  <ul class="flex flex-col gap-px" data-component="sidebar-chat-list">
                    <For each={shownRecents()}>
                      {(session) => (
                        <SessionRow session={session} pinned={false} onTogglePin={() => pins.toggle(session.id)} />
                      )}
                    </For>
                  </ul>
                  <Show when={recentsHaveMore()}>
                    <button
                      type="button"
                      data-action="recents-more"
                      class={`${ROW} text-text-weak`}
                      onClick={() => {
                        if (!recentsExpanded()) return setRecentsExpanded(true)
                        recents.loadMore()
                      }}
                    >
                      <span class="flex-1 truncate">{language.t("sidebar.showMore")}</span>
                    </button>
                  </Show>
                </Show>
              </section>
            </>
          }
        >
          <section aria-labelledby="sidebar-projects-label" class="pt-3">
            <div class={SECTION}>
              <h2 id="sidebar-projects-label" class="text-12-medium">
                {language.t("sidebar.projects")}
              </h2>
              <Tooltip value={language.t("sidebar.projects.open")} placement="right">
                <IconButton
                  icon="plus-small"
                  variant="ghost"
                  size="small"
                  class="size-6"
                  data-action="project-add"
                  onClick={props.onOpenFolder}
                  aria-label={language.t("sidebar.projects.open")}
                />
              </Tooltip>
            </div>
            <Show
              when={projects().length > 0}
              fallback={
                <>
                  <p class="px-2 pb-1.5 text-12-regular text-text-weak">{language.t("sidebar.projects.empty")}</p>
                  <button
                    type="button"
                    data-action="project-open-folder"
                    class={`${ROW} text-text-weak`}
                    onClick={props.onOpenFolder}
                  >
                    <Icon name="folder-add-left" size="small" class="shrink-0 text-icon-weak" />
                    <span class="flex-1 truncate">{language.t("sidebar.projects.open")}</span>
                  </button>
                </>
              }
            >
              <ul class="flex flex-col gap-px">
                <For each={projects()}>
                  {(project) => (
                    <ProjectRow
                      project={project}
                      currentDir={currentDir()}
                      onNewSession={() => props.onNewProjectSession(project.worktree)}
                      onClose={() => props.onCloseProject(project.worktree)}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </section>

          {props.renderRemoteSessions?.()}
        </Show>
      </div>

      <div class="shrink-0 border-t border-border-weaker-base px-2 py-2">
        <DropdownMenu placement="top-start">
          <DropdownMenu.Trigger
            as="button"
            type="button"
            data-action="account-menu"
            class={`${ROW} h-10 data-[expanded]:bg-surface-base-active`}
            aria-label={language.t("sidebar.account.menu")}
          >
            <span
              class="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-base-active text-12-medium text-text-strong"
              aria-hidden="true"
            >
              P
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="truncate text-[13px] text-text-strong" data-slot="account-name">
                {account.detail()?.name ?? language.t("sidebar.account.title")}
              </span>
              <span
                class="truncate text-12-regular"
                classList={{ "text-text-weak": !account.detail()?.low, "text-text-warning-base": !!account.detail()?.low }}
                data-slot="account-plan"
              >
                {account.detail()?.line ??
                  (account.signedIn() ? language.t("sidebar.account.signedIn") : language.t("sidebar.account.signedOut"))}
              </span>
            </span>
            <Icon name="settings-gear" size="small" class="shrink-0 text-icon-weak" />
          </DropdownMenu.Trigger>
          {accountMenu("top")}
        </DropdownMenu>
      </div>
    </div>
  )
}

function ProjectRow(props: {
  project: LocalProject
  currentDir: string
  onNewSession: () => void
  onClose: () => void
}) {
  const language = useLanguage()
  const params = useParams()
  const layout = useLayout()
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))
  const expanded = createMemo(() => props.project.expanded !== false)
  const list = useSessionList(() => props.project.worktree, expanded, PROJECT_SHOWN * 2)
  const [showAll, setShowAll] = createSignal(false)
  const shown = createMemo(() => (showAll() ? list.sessions() : list.sessions().slice(0, PROJECT_SHOWN)))
  const more = createMemo(() => (!showAll() && list.sessions().length > PROJECT_SHOWN) || (showAll() && list.hasMore()))
  const here = createMemo(() => props.currentDir === props.project.worktree && !params.id)
  const toggle = () =>
    expanded() ? layout.projects.collapse(props.project.worktree) : layout.projects.expand(props.project.worktree)

  return (
    <li class="flex flex-col">
      <div class="group/project relative flex items-center">
        <button
          type="button"
          data-action="project-row"
          class={`${ROW} pr-14 ${here() ? ROW_ACTIVE : ""}`}
          onClick={toggle}
          aria-expanded={expanded()}
          title={props.project.worktree}
        >
          <Icon
            name="chevron-right"
            size="small"
            class="shrink-0 text-icon-weak transition-transform duration-150"
            classList={{ "rotate-90": expanded() }}
          />
          <Icon name="folder" size="small" class="shrink-0 text-icon-base" />
          <span class="flex-1 truncate">{name()}</span>
        </button>
        <div class="absolute right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/project:opacity-100 group-focus-within/project:opacity-100 has-[[data-expanded]]:opacity-100">
          <Tooltip value={language.t("sidebar.project.newSession")} placement="top">
            <IconButton
              icon="plus-small"
              variant="ghost"
              size="small"
              class="size-6"
              data-action="project-new-session"
              onClick={props.onNewSession}
              aria-label={language.t("sidebar.project.newSession")}
            />
          </Tooltip>
          <DropdownMenu>
            <DropdownMenu.Trigger
              as={IconButton}
              icon="dot-grid"
              variant="ghost"
              size="small"
              class="size-6"
              aria-label={language.t("common.moreOptions")}
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Content class="mt-1">
                <DropdownMenu.Item onSelect={props.onNewSession}>
                  <DropdownMenu.ItemLabel>{language.t("sidebar.project.newSession")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                <DropdownMenu.Item onSelect={props.onClose}>
                  <DropdownMenu.ItemLabel>{language.t("sidebar.project.close")}</DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      </div>
      <Show when={expanded()}>
        <Show
          when={list.sessions().length > 0}
          fallback={
            <Show when={!list.loading()}>
              <p class="flex h-7 items-center pl-[44px] text-12-regular text-text-weaker">
                {language.t("sidebar.project.noChats")}
              </p>
            </Show>
          }
        >
          <ul class="flex flex-col gap-px">
            <For each={shown()}>{(session) => <SessionRow session={session} indent />}</For>
          </ul>
          <Show when={more()}>
            <button
              type="button"
              class={`${ROW} h-7 pl-[44px] text-text-weak`}
              onClick={() => {
                if (!showAll()) return setShowAll(true)
                list.loadMore()
              }}
            >
              <span class="flex-1 truncate">{language.t("sidebar.showMore")}</span>
            </button>
          </Show>
        </Show>
      </Show>
    </li>
  )
}

function SessionRow(props: { session: Session; indent?: boolean; pinned?: boolean; onTogglePin?: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const navigate = useNavigate()
  const params = useParams()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const notification = useNotification()
  const [editing, setEditing] = createSignal(false)
  // chat threads read "New chat" until titled; project sessions keep the server's "New session"
  const title = createMemo(() =>
    !props.indent && isPlaceholderTitle(props.session.title)
      ? language.t("sidebar.chat.untitled")
      : sessionTitle(props.session.title) || language.t("sidebar.chat.untitled"),
  )
  const slug = createMemo(() => base64Encode(props.session.directory))
  const href = createMemo(() => `/${slug()}/session/${props.session.id}`)
  const active = createMemo(() => params.id === props.session.id)
  const unread = createMemo(() => !active() && notification.session.unseenCount(props.session.id) > 0)
  const working = createMemo(() => {
    const [store] = serverSync().child(props.session.directory, { bootstrap: false })
    const status = store.session_status?.[props.session.id]?.type
    return status === "busy" || status === "retry"
  })

  const rename = async (next: string) => {
    setEditing(false)
    const value = next.trim()
    if (!value || value === props.session.title) return
    await serverSDK()
      .client.session.update({ directory: props.session.directory, sessionID: props.session.id, title: value })
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: String(err) })
      })
  }

  const remove = async () => {
    dialog.close()
    const { directory, id } = props.session
    const wasActive = active()
    const ok = await serverSDK()
      .client.session.delete({ directory, sessionID: id })
      .then(() => true)
      .catch((err: unknown) => {
        showToast({ title: language.t("common.requestFailed"), description: String(err) })
        return false
      })
    if (!ok) return
    const [, setStore] = serverSync().child(directory)
    setStore("session", (list) => (list ?? []).filter((item) => item.id !== id))
    if (wasActive) navigate(`/${slug()}/session`)
  }

  const confirmDelete = () =>
    dialog.show(() => (
      <Dialog title={language.t("sidebar.chat.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <span class="text-14-regular text-text-base max-w-[380px]">
            {language.t("sidebar.chat.delete.description", { title: title() })}
          </span>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={() => void remove()} data-action="chat-delete-confirm">
              {language.t("sidebar.chat.delete.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>
    ))

  const status = (): JSX.Element => (
    <Show
      when={working()}
      fallback={
        <Show when={unread()}>
          <span
            class="size-1.5 shrink-0 rounded-full bg-text-interactive-base"
            aria-label={language.t("sidebar.chat.unread")}
          />
        </Show>
      }
    >
      {/* 10-22: a session at work shows the breathing tilde, the same sign as the header and the TUI */}
      <WorkingMark class="shrink-0 text-[13px]" />
    </Show>
  )

  return (
    <li class="group/chat relative flex items-center" data-session={props.session.id}>
      <Show
        when={!editing()}
        fallback={
          <input
            ref={(el) => requestAnimationFrame(() => el.select())}
            class="h-8 w-full rounded-lg bg-background-stronger px-2.5 text-[13px] text-text-strong outline-none shadow-xs-border-focus"
            classList={{ "ml-[36px]": props.indent }}
            value={props.session.title ?? ""}
            aria-label={language.t("sidebar.chat.rename")}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename(e.currentTarget.value)
              if (e.key === "Escape") setEditing(false)
            }}
            onBlur={(e) => void rename(e.currentTarget.value)}
          />
        }
      >
        <A
          href={href()}
          class={`${ROW} pr-8 ${props.indent ? "h-7 pl-[44px]" : ""} ${active() ? ROW_ACTIVE : ""}`}
          classList={{ "font-medium text-text-strong": unread() }}
          aria-current={active() ? "page" : undefined}
          onDblClick={() => setEditing(true)}
        >
          <span class="flex-1 truncate">{title()}</span>
          <span class="flex w-3 justify-center group-hover/chat:hidden group-focus-within/chat:hidden">{status()}</span>
        </A>
        <DropdownMenu>
          <DropdownMenu.Trigger
            as={IconButton}
            icon="dot-grid"
            variant="ghost"
            size="small"
            data-action="chat-menu"
            class="absolute right-1 size-6 opacity-0 transition-opacity group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 data-[expanded]:opacity-100"
            aria-label={language.t("sidebar.chat.menu")}
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="mt-1">
              <Show when={props.onTogglePin}>
                {(toggle) => (
                  <DropdownMenu.Item onSelect={() => toggle()()} data-action="chat-pin">
                    <DropdownMenu.ItemLabel>
                      {language.t(props.pinned ? "sidebar.chat.unpin" : "sidebar.chat.pin")}
                    </DropdownMenu.ItemLabel>
                  </DropdownMenu.Item>
                )}
              </Show>
              <DropdownMenu.Item onSelect={() => setEditing(true)} data-action="chat-rename">
                <DropdownMenu.ItemLabel>{language.t("sidebar.chat.rename")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={confirmDelete} data-action="chat-delete">
                <DropdownMenu.ItemLabel>{language.t("sidebar.chat.delete")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </Show>
    </li>
  )
}
