import { Button } from "@opencode-ai/ui/button"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"

/** 10-22: Code picked with no folder open: say what Code is for and offer the folder picker. */
export function CodeHomeView() {
  const language = useLanguage()
  const command = useCommand()
  return (
    <div class="size-full overflow-y-auto" data-component="code-home">
      <div class="min-h-full flex flex-col items-center justify-center px-6 pt-10 pb-[14vh]">
        <div class="w-full max-w-[520px] flex flex-col items-center gap-5 text-center">
          <h1 class="text-[22px] leading-tight font-medium tracking-[-0.01em] text-text-strong">
            {language.t("home.code.title")}
          </h1>
          <p class="text-14-regular text-text-weak leading-relaxed">{language.t("home.code.description")}</p>
          <Button variant="primary" size="large" class="px-4" onClick={() => command.trigger("project.open")}>
            {language.t("home.code.openFolder")}
          </Button>
        </div>
      </div>
    </div>
  )
}
