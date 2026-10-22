import { createMemo, createRoot, createSignal, onCleanup, onMount, Show, type Accessor, type Setter } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { authTokenFromCredentials } from "@/utils/server"
import { openPraexSignIn, PRAEX_PROVIDER_ID } from "./praex-sign-in-card"

// 10-22: the Praex account in the desktop app: who is signed in, the plan and today's allowance. The local
// server's /praex/account reads the gateway with the signed-in token (it never reaches the app). Read when
// the app starts and after replies at most once a minute; Settings asks for a fresh read when it opens.
export type PraexAccount = {
  signedIn: boolean
  plan?: string
  used?: number
  inFlight?: number
  allowance?: number
  left?: number
  resetsAt?: string
  email?: string
  name?: string
  error?: string
}

export const LOW_ALLOWANCE = 0.2
const REFRESH_MS = 60_000

type Store = { account: Accessor<PraexAccount | undefined>; set: Setter<PraexAccount | undefined>; last: number; pending?: Promise<void> }
const stores = new Map<string, Store>()
function storeFor(key: string) {
  const hit = stores.get(key)
  if (hit) return hit
  const [account, set] = createRoot(() => createSignal<PraexAccount>())
  const next: Store = { account, set, last: 0 }
  stores.set(key, next)
  return next
}

export function usePraexAccountInfo() {
  const server = useServer()
  const platform = usePlatform()
  const store = createMemo(() => storeFor(server.current?.http.url ?? ""))
  const refresh = (fresh = false): Promise<void> => {
    const conn = server.current
    const item = store()
    if (!conn) return Promise.resolve()
    if (item.pending) return item.pending
    if (!fresh && Date.now() - item.last < REFRESH_MS) return Promise.resolve()
    item.last = Date.now()
    const headers: Record<string, string> = conn.http.password
      ? { Authorization: `Basic ${authTokenFromCredentials({ username: conn.http.username, password: conn.http.password })}` }
      : {}
    item.pending = (platform.fetch ?? fetch)(`${conn.http.url}/praex/account${fresh ? "?fresh=1" : ""}`, { headers })
      .then((res) => (res.ok ? (res.json() as Promise<PraexAccount>) : undefined))
      .then((value) => {
        if (value && typeof value.signedIn === "boolean") item.set(value)
      })
      .catch(() => {})
      .finally(() => {
        item.pending = undefined
      })
    return item.pending
  }
  return { account: () => store().account(), refresh }
}

/** Refresh after replies (a session going idle), throttled; mount once in an always-visible place. */
export function usePraexAccountRefresh() {
  const serverSDK = useServerSDK()
  const info = usePraexAccountInfo()
  onMount(() => void info.refresh())
  const unsub = serverSDK().event.listen((e) => {
    if (e.details.type === "session.idle") void info.refresh()
  })
  onCleanup(unsub)
  return info
}

export function usePraexFreeModelName() {
  const serverSync = useServerSync()
  return createMemo(() => {
    const models = Object.values(serverSync().data.provider.all.get(PRAEX_PROVIDER_ID)?.models ?? {}) as { name: string }[]
    const free = models.find((model) => /·\s*free$/i.test(model.name)) ?? models[0]
    return free?.name.split(" · ")[0] ?? "Velox"
  })
}

export function useAllowanceText() {
  const language = useLanguage()
  const resets = (resetsAt: string | undefined) => {
    const ms = resetsAt ? Date.parse(resetsAt) - Date.now() : NaN
    if (!(ms > 0)) return language.t("praex.account.resetsSoon")
    const hours = Math.floor(ms / 3_600_000)
    const time = hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(ms / 60_000))} min`
    return language.t("praex.account.resets", { time })
  }
  const left = (value: number) => {
    if (value <= 0) return language.t("praex.account.usedUp")
    if (value < 0.01) return language.t("praex.account.leftUnder1")
    return language.t("praex.account.left", { percent: String(Math.floor(value * 100)) })
  }
  /** for the narrow account button: "13% left today" */
  const short = (value: number) =>
    value <= 0
      ? language.t("praex.account.usedUpShort")
      : language.t("praex.account.leftShort", { percent: value < 0.01 ? "<1" : String(Math.floor(value * 100)) })
  const plan = (value: string | undefined) =>
    value ? language.t("praex.account.plan", { plan: value[0]!.toUpperCase() + value.slice(1) }) : language.t("sidebar.account.title")
  return {
    left,
    short,
    plan,
    /** "Free plan · 62% of today's allowance left · resets in 5 h" */
    line: (account: PraexAccount) =>
      [plan(account.plan), ...(account.left !== undefined ? [left(account.left), resets(account.resetsAt)] : [])].join(" · "),
  }
}

/** Settings > General: the account, plan and today's allowance, with sign-in or upgrade. */
export function PraexAccountSettings() {
  const language = useLanguage()
  const dialog = useDialog()
  const platform = usePlatform()
  const serverSync = useServerSync()
  const info = usePraexAccountInfo()
  const text = useAllowanceText()
  const free = usePraexFreeModelName()
  onMount(() => void info.refresh(true))
  const signedIn = createMemo(
    () =>
      (serverSync().data.provider.all.get(PRAEX_PROVIDER_ID)?.options as Record<string, unknown> | undefined)?.signedIn ===
      true,
  )
  const account = () => info.account()

  return (
    <div class="flex flex-col gap-1" data-component="praex-account-settings">
      <h3 class="text-14-medium text-text-strong pb-2">{language.t("sidebar.account.title")}</h3>
      <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base sm:flex-nowrap">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5">
          <Show
            when={signedIn()}
            fallback={
              <>
                <span class="text-14-medium text-text-strong">{language.t("sidebar.account.signedOut")}</span>
                <span class="text-12-regular text-text-weak">{language.t("praex.account.signedOut", { model: free() })}</span>
              </>
            }
          >
            <span class="text-14-medium text-text-strong" data-slot="praex-account-name">
              {account()?.email ?? language.t("sidebar.account.title")}
            </span>
            <span class="text-12-regular text-text-weak" data-slot="praex-account-plan">
              {account()?.signedIn ? text.line(account()!) : language.t("praex.account.reading")}
            </span>
            <Show when={account()?.error}>
              <span class="text-12-regular text-text-weak">{account()?.error}</span>
            </Show>
            <Show when={account()?.plan === "free"}>
              <span class="text-12-regular text-text-weak">{language.t("praex.account.upgrade")}</span>
            </Show>
          </Show>
        </div>
        <div class="flex w-full justify-end sm:w-auto sm:shrink-0">
          <Show
            when={signedIn()}
            fallback={
              <Button variant="primary" size="normal" class="px-3" onClick={() => openPraexSignIn(dialog)}>
                {language.t("praex.signin.action")}
              </Button>
            }
          >
            <Show when={account()?.plan === "free"}>
              <Button variant="secondary" size="normal" class="px-3" onClick={() => platform.openLink("https://praex.ai")}>
                {language.t("praex.account.upgrade.action")}
              </Button>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}
