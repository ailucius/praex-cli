import { createMemo, createSignal, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { Accordion } from "@opencode-ai/ui/accordion"
import { Button } from "@opencode-ai/ui/button"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { DockPrompt } from "@opencode-ai/ui/dock-prompt"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { resolveFileDiff } from "@opencode-ai/ui/session-diff"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { useLanguage } from "@/context/language"
import { permissionDiffs, type PermissionDiffEntry } from "./session-permission-diff"

function PermissionDiff(props: { entry: PermissionDiffEntry }) {
  const language = useLanguage()
  const fileComponent = useFileComponent()
  const fileDiff = createMemo(() => {
    try {
      return resolveFileDiff({ file: props.entry.file, patch: props.entry.patch })
    } catch {
      return
    }
  })
  const directory = () => (props.entry.file.includes("/") ? getDirectory(props.entry.file) : "")

  return (
    <Accordion.Item value={props.entry.file} data-type="update">
      <StickyAccordionHeader>
        <Accordion.Trigger
          aria-label={language.t("notification.permission.diff.toggle", { file: props.entry.file })}
        >
          <div data-slot="apply-patch-trigger-content">
            <div data-slot="apply-patch-file-info">
              <FileIcon node={{ path: props.entry.file, type: "file" }} />
              <div data-slot="apply-patch-file-name-container">
                <Show when={directory()}>
                  <span data-slot="apply-patch-directory">{`‪${directory()}‬`}</span>
                </Show>
                <span data-slot="apply-patch-filename">{getFilename(props.entry.file)}</span>
              </div>
            </div>
            <div data-slot="apply-patch-trigger-actions">
              <Show when={!props.entry.truncated}>
                <DiffChanges changes={props.entry} />
              </Show>
              <Icon name="chevron-grabber-vertical" size="small" />
            </div>
          </div>
        </Accordion.Trigger>
      </StickyAccordionHeader>
      <Accordion.Content>
        <div data-component="edit-content" data-slot="permission-diff-content">
          <Show
            when={fileDiff()}
            fallback={
              <pre data-slot="permission-diff-raw">
                <code>{props.entry.patch}</code>
              </pre>
            }
          >
            {(diff) => (
              <Dynamic
                component={fileComponent}
                mode="diff"
                virtualize={false}
                fileDiff={diff()}
                hunkSeparators={diff().isPartial ? "simple" : "line-info-basic"}
              />
            )}
          </Show>
        </div>
        <Show when={props.entry.truncated}>
          {(cut) => (
            <div data-slot="permission-diff-note">
              {language.t("notification.permission.diff.truncated", { shown: cut().shown, total: cut().total })}
            </div>
          )}
        </Show>
      </Accordion.Content>
    </Accordion.Item>
  )
}

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const diffs = createMemo(() => permissionDiffs(props.request))
  const [expanded, setExpanded] = createSignal<string[] | undefined>()
  // Every file starts open: the change is what the user is being asked to approve.
  const open = () => expanded() ?? diffs().map((entry) => entry.file)

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={diffs().length > 0}>
        <div data-slot="permission-diffs">
          <Accordion
            multiple
            data-scope="apply-patch"
            style={{ "--sticky-accordion-offset": "0px" }}
            value={open()}
            onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
          >
            <For each={diffs()}>{(entry) => <PermissionDiff entry={entry} />}</For>
          </Accordion>
        </div>
      </Show>
    </DockPrompt>
  )
}
