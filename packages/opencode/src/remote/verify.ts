// The computer's own check on whoever the relay forwards. The relay already verified the
// phone's Firebase ID token; the CLI verifies it AGAIN before it issues a grant, so a
// relay that is buggy or compromised cannot attach to this machine without a token that
// Google signed for this same uid. Same approach as the relay and praex-gateway: Google's
// securetoken JWKS, WebCrypto, no dependencies.

export const PROJECT_ID = "lucius-ai-482407"
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"

const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

export function decodeJwtPayload(token: string): Record<string, any> | undefined {
  try {
    const p = token.split(".")[1]
    return p ? JSON.parse(new TextDecoder().decode(b64u(p))) : undefined
  } catch {
    return undefined
  }
}

/** The uid a token names, without verifying it (for the CLI's OWN token, which it got from Google). */
export function uidOf(token: string, fake = false): string | undefined {
  if (fake) return /^test:([A-Za-z0-9_-]{1,64})$/.exec(token)?.[1]
  const p = decodeJwtPayload(token)
  const uid = p?.user_id ?? p?.sub
  return typeof uid === "string" && uid ? uid : undefined
}

export type PhoneVerifier = (idToken: string) => Promise<string | null>

export function firebasePhoneVerifier(projectId = PROJECT_ID, fetchImpl: typeof fetch = fetch): PhoneVerifier {
  let jwks: { keys: any[]; exp: number } | null = null
  async function keys(force = false) {
    if (!force && jwks && jwks.exp > Date.now()) return jwks.keys
    const res = await fetchImpl(JWKS_URL)
    if (!res.ok) throw new Error(`jwks ${res.status}`)
    jwks = { keys: ((await res.json()) as any).keys, exp: Date.now() + 3600_000 }
    return jwks.keys
  }
  return async (jwt) => {
    try {
      const [h, p, sig] = jwt.split(".")
      if (!h || !p || !sig) return null
      const header = JSON.parse(new TextDecoder().decode(b64u(h)))
      const payload = JSON.parse(new TextDecoder().decode(b64u(p)))
      if (header.alg !== "RS256") return null
      const jwk =
        (await keys()).find((k: any) => k.kid === header.kid) ??
        (await keys(true)).find((k: any) => k.kid === header.kid)
      if (!jwk) return null
      const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
        "verify",
      ])
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(sig), new TextEncoder().encode(h + "." + p))
      if (!ok) return null
      if (payload.aud !== projectId) return null
      if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null
      if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null
      if (payload.firebase?.sign_in_provider === "anonymous") return null
      const uid = payload.user_id ?? payload.sub
      return typeof uid === "string" && uid ? uid : null
    } catch {
      return null
    }
  }
}

/** Local tests only: "test:<uid>" tokens. Never used against a non-loopback relay. */
export const fakePhoneVerifier: PhoneVerifier = async (token) =>
  /^test:([A-Za-z0-9_-]{1,64})$/.exec(token)?.[1] ?? null
