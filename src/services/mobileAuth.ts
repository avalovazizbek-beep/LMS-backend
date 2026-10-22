import { createHash, randomBytes, timingSafeEqual } from "crypto"

/* ── Mobil ilova uchun HEMIS orqali kirish ──────────────────────────────
   Ilova HEMIS sahifasini o'z ichidagi brauzerda ochadi (/oauth/start/:role
   ?app_redirect=...&code_challenge=...). Kirish tugagach server tokenni URL'da
   emas, BIR MARTALIK qisqa kodni ilovaga qaytaradi (samisi://auth?code=...).
   Ilova kodni /oauth/mobile/redeem orqali tokenga almashtiradi va PKCE
   "verifier"ini yuboradi — kodni ushlab olgan boshqa ilova verifier'ni
   bilmagani uchun undan foydalana olmaydi (RFC 7636, S256). */

const HANDOFF_TTL_MS = 2 * 60 * 1000
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/

/** Ilovaning o'z sxemasi (app.json → expo.scheme) */
const APP_SCHEME = "samisi:"

type Handoff = { token: string; role: string; challenge: string; expiresAt: number }
const handoffs = new Map<string, Handoff>()

function cleanup(now = Date.now()) {
  for (const [code, h] of handoffs) if (h.expiresAt <= now) handoffs.delete(code)
}

/** Kirishdan keyin ilovaga qaytish manzili. Faqat ilovaning o'z sxemasi;
    ishlab chiqish paytida (MOBILE_DEV_REDIRECTS=1) Expo Go va localhost ham. */
export function isAllowedAppRedirect(value: unknown, devAllowed = process.env.MOBILE_DEV_REDIRECTS === "1"): value is string {
  if (typeof value !== "string" || value.length > 300) return false
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.search || url.hash) return false
  if (url.protocol === APP_SCHEME) return true
  if (!devAllowed) return false
  if (url.protocol === "exp:" || url.protocol === "exps:") return true
  return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1")
}

export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_RE.test(value)
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

/** Muvaffaqiyatli kirishdan keyin: token o'rniga bir martalik kod */
export function createMobileHandoff(token: string, role: string, challenge: string): string {
  cleanup()
  const code = randomBytes(24).toString("base64url")
  handoffs.set(code, { token, role, challenge, expiresAt: Date.now() + HANDOFF_TTL_MS })
  return code
}

/** Kodni tokenga almashtiradi. Kod har qanday urinishdan keyin yo'q qilinadi. */
export function redeemMobileHandoff(code: unknown, verifier: unknown): { token: string; role: string } | null {
  if (typeof code !== "string" || !code || typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return null
  cleanup()
  const h = handoffs.get(code)
  if (!h) return null
  handoffs.delete(code)
  if (h.expiresAt <= Date.now()) return null
  const expected = Buffer.from(h.challenge)
  const actual = Buffer.from(pkceChallenge(verifier))
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return { token: h.token, role: h.role }
}

/** app_redirect'ga parametr qo'shib qaytaradi (masalan ?code=... yoki ?error=...) */
export function appRedirectUrl(appRedirect: string, params: Record<string, string>): string {
  const url = new URL(appRedirect)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}
