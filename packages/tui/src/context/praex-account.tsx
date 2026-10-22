import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useEvent } from "./event"
import type { PraexAccount } from "../util/praex-account"

// 10-22: plan, today's allowance and the account's email for /usage, /status and the footer. Read from the
// local server's /praex/account (which asks the gateway with the signed-in token) when the TUI starts and
// after each reply, at most once a minute; /usage and /status ask for a fresh read when they open.
const REFRESH_MS = 60_000

export const { use: usePraexAccount, provider: PraexAccountProvider } = createSimpleContext({
  name: "PraexAccount",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const event = useEvent()
    const [account, setAccount] = createSignal<PraexAccount>()
    let last = 0
    let pending: Promise<void> | undefined

    const refresh = (fresh = false): Promise<void> => {
      if (pending) return pending
      if (!fresh && Date.now() - last < REFRESH_MS) return Promise.resolve()
      last = Date.now()
      pending = sdk
        .fetch(`${sdk.url}/praex/account${fresh ? "?fresh=1" : ""}`)
        .then((res) => (res.ok ? (res.json() as Promise<PraexAccount>) : undefined))
        .then((value) => {
          if (value && typeof value.signedIn === "boolean") setAccount(value)
        })
        .catch(() => {})
        .finally(() => {
          pending = undefined
        })
      return pending
    }

    // after replies: a session going idle
    const off = event.on("session.status", (evt) => {
      if (evt.properties.status.type === "idle") void refresh()
    })
    onCleanup(off)

    // signing in or out (provider options change after /login): read again at once
    createEffect(
      on(
        () => sync.data.provider.find((item) => item.id === "praex-cloud")?.options?.signedIn === true,
        () => void refresh(true),
      ),
    )

    return { account, refresh }
  },
})
