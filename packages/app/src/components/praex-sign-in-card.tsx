import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Card } from "@opencode-ai/ui/card"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { DialogConnectProvider } from "./dialog-connect-provider"

export const PRAEX_PROVIDER_ID = "praex-cloud"

/** The gateway's 401 text ("Sign in required. In the terminal run `praex login`, or sign in at https://praex.ai/chat …"). */
export function isPraexSignInError(text: string | undefined) {
  if (!text) return false
  // "praex auth login": the CLI's own answer when Praex is picked while signed out (no request is sent)
  return /sign in required|praex (?:auth )?login|sign in at https:\/\/praex\.ai/i.test(text)
}

export function openPraexSignIn(dialog: ReturnType<typeof useDialog>) {
  dialog.show(() => <DialogConnectProvider provider={PRAEX_PROVIDER_ID} />)
}

export function PraexSignInCard(props: { text?: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  return (
    <Card variant="info" class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <div class="text-14-medium text-text-strong">{language.t("praex.signin.title")}</div>
        <div class="text-12-regular text-text-weak">{language.t("praex.signin.description")}</div>
      </div>
      <div>
        <Button variant="primary" size="normal" class="px-3" onClick={() => openPraexSignIn(dialog)}>
          {language.t("praex.signin.action")}
        </Button>
      </div>
      <Show when={props.text}>
        <div class="text-12-regular text-text-weak opacity-60">{props.text}</div>
      </Show>
    </Card>
  )
}
