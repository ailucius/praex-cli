/** Turns more than this far apart get a day/time label in the timeline. */
export const TURN_GAP_MS = 60 * 60 * 1000

/** "Today 9:02 AM", "Yesterday 11:51 PM", "Mon 3:40 PM" (this week) or "Oct 12, 3:40 PM". */
export function formatTurnTime(at: number, locale: string, now = Date.now()) {
  const date = new Date(at)
  const time = date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
  const startOf = (value: number) => {
    const d = new Date(value)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const days = Math.round((startOf(now) - startOf(at)) / 86_400_000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  const capitalize = (value: string) => value.charAt(0).toLocaleUpperCase(locale) + value.slice(1)
  if (days === 0 || days === 1) return `${capitalize(rtf.format(-days, "day"))} ${time}`
  if (days > 1 && days < 7) return `${date.toLocaleDateString(locale, { weekday: "short" })} ${time}`
  return `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`
}
