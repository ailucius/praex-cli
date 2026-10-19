import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { setWebSearch, webSearch } from "@/utils/web-search"

/** The composer's + menu: add files, take a screenshot (desktop), connectors. */
export function ComposerPlusMenu(props: {
  disabled?: boolean
  tabIndex?: number
  style?: JSX.CSSProperties
  uploadKeybind?: string
  onUpload: () => void
  onScreenshot?: () => void
  onConnectors: () => void
}) {
  const language = useLanguage()
  return (
    <DropdownMenu placement="top-start" gutter={6}>
      <Tooltip placement="top" value={language.t("composer.plus.title")}>
        <DropdownMenu.Trigger
          as={Button}
          data-action="prompt-attach"
          type="button"
          variant="ghost"
          class="size-8 p-0"
          style={props.style}
          disabled={props.disabled}
          tabIndex={props.tabIndex}
          aria-label={language.t("composer.plus.title")}
        >
          <Icon name="plus" class="size-4.5" />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="min-w-[230px]" data-component="composer-plus-menu">
          <DropdownMenu.Item onSelect={props.onUpload} data-action="composer-upload">
            <Icon name="photo" size="small" class="text-icon-weak" />
            <DropdownMenu.ItemLabel class="flex-1">{language.t("composer.plus.upload")}</DropdownMenu.ItemLabel>
            <Show when={props.uploadKeybind}>
              {(keybind) => <span class="pl-4 text-12-regular text-text-weaker">{keybind()}</span>}
            </Show>
          </DropdownMenu.Item>
          <Show when={props.onScreenshot}>
            {(capture) => (
              <DropdownMenu.Item onSelect={() => capture()()} data-action="composer-screenshot">
                <Icon name="window-cursor" size="small" class="text-icon-weak" />
                <DropdownMenu.ItemLabel>{language.t("composer.plus.screenshot")}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            )}
          </Show>
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem
            checked={webSearch()}
            onChange={setWebSearch}
            closeOnSelect={false}
            data-action="composer-web-search"
          >
            <Icon name="magnifying-glass" size="small" class="text-icon-weak" />
            <DropdownMenu.ItemLabel class="flex-1">{language.t("composer.plus.webSearch")}</DropdownMenu.ItemLabel>
            <DropdownMenu.ItemIndicator class="pl-4">
              <Icon name="check-small" size="small" class="text-icon-strong" />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>
          <DropdownMenu.Item onSelect={props.onConnectors} data-action="composer-connectors">
            <Icon name="mcp" size="small" class="text-icon-weak" />
            <DropdownMenu.ItemLabel>{language.t("composer.plus.connectors")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
