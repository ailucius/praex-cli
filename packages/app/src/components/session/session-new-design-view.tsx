import type { JSX } from "solid-js"
import { Logo } from "@opencode-ai/ui/logo"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          {/* Praex wordmark: the mark stays white on black in both themes, only the text follows the theme */}
          <Logo class="mx-auto h-auto w-[min(18rem,60%)]" />
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
