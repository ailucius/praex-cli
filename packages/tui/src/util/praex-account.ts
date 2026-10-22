// 10-22: the Praex account as the server's /praex/account returns it (the gateway's /v1/billing/plan,
// read with the signed-in token on the server side), and the lines /usage, /status and the footer show.
export type PraexAccount = {
  signedIn: boolean
  plan?: string
  used?: number
  inFlight?: number
  allowance?: number
  /** share of today's allowance left, 0 to 1 */
  left?: number
  resetsAt?: string
  email?: string
  name?: string
  sources?: string[]
  error?: string
}

/** Below this share left, the footer says how much of today's allowance remains. */
export const LOW_ALLOWANCE = 0.2

export function planLabel(plan: string | undefined) {
  if (!plan) return "Praex plan"
  return `${plan[0]!.toUpperCase()}${plan.slice(1)} plan`
}

export function resetsIn(resetsAt: string | undefined, now = Date.now()) {
  const ms = resetsAt ? Date.parse(resetsAt) - now : NaN
  if (!(ms > 0)) return "soon"
  const hours = Math.floor(ms / 3_600_000)
  if (hours >= 1) return `${hours}\u00a0h` // no break between number and unit
  return `${Math.max(1, Math.round(ms / 60_000))}\u00a0min`
}

export function leftText(left: number) {
  if (left <= 0) return "today's allowance is used up"
  if (left < 0.01) return "under 1% of today's allowance left"
  return `${Math.floor(left * 100)}% of today's allowance left`
}

/** "Free plan · 62% of today's allowance left · resets in 5 h" */
export function allowanceLine(account: PraexAccount, now = Date.now()) {
  const parts = [planLabel(account.plan)]
  if (account.left !== undefined) parts.push(leftText(account.left), `resets in ${resetsIn(account.resetsAt, now)}`)
  return parts.join(" · ")
}

/** Shown to free users next to the meter. */
export const UPGRADE_HINT = "Praex Pro ($20/month) adds Faber II and a bigger daily allowance. Upgrade at praex.ai."

export function accountName(account: PraexAccount | undefined) {
  return account?.email ?? "Praex account"
}
