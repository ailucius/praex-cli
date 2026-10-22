// A user message sent while a turn runs waits until the next step of the turn reads it. Until
// then nothing depends on it, so it can be taken back even though the session is busy.
export function isQueuedUserMessage(
  messages: readonly { info: { id: string; role: string; parentID?: string } }[],
  messageID: string,
) {
  const target = messages.find((message) => message.info.id === messageID)
  if (!target || target.info.role !== "user") return false
  return !messages.some(
    (message) =>
      message.info.role === "assistant" && (message.info.id > messageID || message.info.parentID === messageID),
  )
}
