const pattern = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/** True for the server's placeholder title ("New session - <time>") before a real one exists. */
export function isPlaceholderTitle(title?: string) {
  return !title || pattern.test(title)
}

export function sessionTitle(title?: string) {
  if (!title) return title
  const match = title.match(pattern)
  return match?.[1] ?? title
}
