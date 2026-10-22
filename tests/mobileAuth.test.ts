import "./setup"
// HEMIS OAuth sozlamalari hemis.ts yuklanishidan oldin (sinov qiymatlari)
process.env.HEMIS_OAUTH_CLIENT_ID = "test-client"
process.env.HEMIS_OAUTH_CLIENT_SECRET = "test-secret"
process.env.HEMIS_OAUTH_STUDENT_CLIENT_ID = "test-student-client"
process.env.HEMIS_OAUTH_STUDENT_CLIENT_SECRET = "test-student-secret"

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createHash, randomBytes } from "crypto"
import jwt from "jsonwebtoken"
import { startApp, rawGet } from "./helpers"
import hemisRoutes from "../src/routes/hemis"
import { isAllowedAppRedirect, isValidCodeChallenge, createMobileHandoff, redeemMobileHandoff, pkceChallenge, appRedirectUrl } from "../src/services/mobileAuth"

const verifier = () => randomBytes(32).toString("base64url")
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url")

test("isAllowedAppRedirect: faqat ilova sxemasi, dev rejimda Expo Go va localhost", () => {
  assert.equal(isAllowedAppRedirect("samisi://auth", false), true)
  for (const bad of ["https://evil.example/auth", "http://localhost:8081/auth", "exp://192.168.1.5:8081/--/auth", "samisi://auth?x=1", "samisi://auth#x", "javascript:alert(1)", "", 42, null]) {
    assert.equal(isAllowedAppRedirect(bad, false), false, String(bad))
  }
  assert.equal(isAllowedAppRedirect("exp://192.168.1.5:8081/--/auth", true), true)
  assert.equal(isAllowedAppRedirect("http://localhost:8081/auth", true), true)
  assert.equal(isAllowedAppRedirect("https://evil.example/auth", true), false)
  assert.equal(isAllowedAppRedirect("http://localhost.evil.example/auth", true), false)
})

test("PKCE: challenge formati va S256", () => {
  const v = verifier()
  assert.equal(pkceChallenge(v), challengeOf(v))
  assert.equal(isValidCodeChallenge(challengeOf(v)), true)
  for (const bad of ["short", "a".repeat(44), "a+b/".repeat(11), undefined]) assert.equal(isValidCodeChallenge(bad), false, String(bad))
})

test("bir martalik kod: to'g'ri verifier bilan bir marta, noto'g'ri verifier kodni yo'q qiladi", () => {
  const v = verifier()
  const code = createMobileHandoff("jwt-token", "student", challengeOf(v))
  assert.deepEqual(redeemMobileHandoff(code, v), { token: "jwt-token", role: "student" })
  assert.equal(redeemMobileHandoff(code, v), null, "ikkinchi marta ishlamasligi kerak")

  const v2 = verifier()
  const code2 = createMobileHandoff("jwt-2", "employee", challengeOf(v2))
  assert.equal(redeemMobileHandoff(code2, verifier()), null, "boshqa verifier")
  assert.equal(redeemMobileHandoff(code2, v2), null, "xato urinishdan keyin kod o'chgan bo'lishi kerak")
  assert.equal(redeemMobileHandoff("yo'q-kod", v2), null)
  assert.equal(redeemMobileHandoff(code2, "qisqa"), null)
})

test("appRedirectUrl: parametrlar URL'ga xavfsiz qo'shiladi", () => {
  assert.equal(appRedirectUrl("samisi://auth", { code: "a b&c" }), "samisi://auth?code=a+b%26c")
})

/* ── Marshrutlar ── */
let app: Awaited<ReturnType<typeof startApp>>
before(async () => { app = await startApp((a) => a.use("/api/hemis", hemisRoutes)) })
after(async () => { await app.close() })

test("/oauth/start: yaroqsiz app_redirect yoki challenge 400", async () => {
  const ch = challengeOf(verifier())
  for (const q of [
    `app_redirect=${encodeURIComponent("https://evil.example/auth")}&code_challenge=${ch}`,
    `app_redirect=${encodeURIComponent("samisi://auth")}&code_challenge=short`,
    `app_redirect=${encodeURIComponent("samisi://auth")}`,
  ]) {
    const r = await rawGet(app.base, `/api/hemis/oauth/start/student?${q}`)
    assert.equal(r.status, 400, q)
  }
})

test("/oauth/start: ilova manzili va challenge imzolangan state ichida HEMIS'ga yuboriladi", async () => {
  const ch = challengeOf(verifier())
  const r = await rawGet(app.base, `/api/hemis/oauth/start/student?app_redirect=${encodeURIComponent("samisi://auth")}&code_challenge=${ch}`)
  assert.equal(r.status, 302)
  const location = new URL(String(r.headers.location))
  const state = location.searchParams.get("state") as string
  const payload = jwt.verify(state, process.env.JWT_SECRET as string) as Record<string, unknown>
  assert.equal(payload.appRedirect, "samisi://auth")
  assert.equal(payload.codeChallenge, ch)

  // Oddiy (sayt) kirishi o'zgarmagan
  const web = await rawGet(app.base, "/api/hemis/oauth/start/student")
  assert.equal(web.status, 302)
  const webState = jwt.verify(new URL(String(web.headers.location)).searchParams.get("state") as string, process.env.JWT_SECRET as string) as Record<string, unknown>
  assert.equal(webState.appRedirect, undefined)
})

test("/oauth/mobile/redeem: kod + verifier → token, keyin yaroqsiz", async () => {
  const v = verifier()
  const code = createMobileHandoff("jwt-route", "student", challengeOf(v))
  const post = (body: unknown) => fetch(`${app.base}/api/hemis/oauth/mobile/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

  let res = await post({ code, code_verifier: verifier() })
  assert.equal(res.status, 400)
  const code2 = createMobileHandoff("jwt-route-2", "student", challengeOf(v))
  res = await post({ code: code2, code_verifier: v })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { success: true, token: "jwt-route-2", role: "student" })
  res = await post({ code: code2, code_verifier: v })
  assert.equal(res.status, 400)
})
