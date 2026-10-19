import { For, type JSX, Show } from "solid-js"
import { Mark } from "@opencode-ai/ui/logo"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { useLocal } from "@/context/local"
import { COWORK_AGENT } from "@/utils/chat-workspace"

// Starters prefill the composer (never send): the person finishes the sentence.
const STARTERS = [
  { key: "home.chat.starter.write", text: "Help me write " },
  { key: "home.chat.starter.learn", text: "Explain " },
  { key: "home.chat.starter.plan", text: "Help me plan " },
  { key: "home.chat.starter.code", text: "Look at this code and tell me what it does:\n\n" },
] as const

/** The chat home: a centred greeting and composer, no folder needed. */
export function ChatHomeView(props: { composer: JSX.Element }) {
  const language = useLanguage()
  const prompt = usePrompt()
  const command = useCommand()
  const local = useLocal()
  const cowork = () => local.agent.current()?.name === COWORK_AGENT

  const start = (text: string) => {
    prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
    requestAnimationFrame(() => {
      const editor = document.querySelector<HTMLElement>(
        '[data-component="session-prompt-dock"] [contenteditable="true"]',
      )
      editor?.focus()
    })
  }

  return (
    <div class="size-full overflow-y-auto" data-component="chat-home">
      <div class="min-h-full flex flex-col items-center justify-center px-6 pt-10 pb-[14vh]">
        <div class="w-full max-w-[720px] flex flex-col items-center gap-7">
          <div class="flex flex-col items-center gap-4 text-center">
            <Mark class="w-9" />
            <h1 class="text-[26px] leading-tight font-medium tracking-[-0.01em] text-text-strong">
              {language.t("home.chat.greeting")}
            </h1>
          </div>
          <div class="w-full">{props.composer}</div>
          <div
            class="flex flex-wrap items-center justify-center gap-2"
            role="group"
            aria-label={language.t("home.chat.starters")}
          >
            <For each={STARTERS}>
              {(starter) => (
                <button
                  type="button"
                  class="h-8 px-3.5 rounded-full border border-border-weak-base bg-background-base text-[13px] text-text-base transition-colors hover:bg-surface-raised-base-hover hover:text-text-strong outline-none focus-visible:shadow-xs-border-focus"
                  onClick={() => start(starter.text)}
                >
                  {language.t(starter.key)}
                </button>
              )}
            </For>
          </div>
          <p class="text-12-regular text-text-weak text-center max-w-[460px]">
            {language.t(cowork() ? "home.cowork.scope" : "home.chat.scope")}{" "}
            <button
              type="button"
              class="text-text-base underline underline-offset-2 decoration-border-base hover:text-text-strong outline-none focus-visible:shadow-xs-border-focus rounded-sm"
              onClick={() => command.trigger("project.open")}
            >
              {language.t(cowork() ? "home.cowork.openFolder" : "home.chat.openFolder")}
            </button>
            <Show when={cowork()}>.</Show>
          </p>
        </div>
      </div>
    </div>
  )
}
