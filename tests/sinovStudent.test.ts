import "./setup"
import crypto from "crypto"
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { stubDb, token, startApp } from "./helpers"
import sinovRoutes from "../src/routes/sinov"
import { sinovGuard, SINOV_GROUP_ID } from "../src/services/sinovSandbox"

/* Sinov (demo) talabasi: login + parol (bazada faqat xeshi), HEMIS so'rovlari
   soxta profil / bo'sh javob bilan yopiladi, qolganlari odatdagidek o'tadi. */

const PASSWORD = "Sinov-Pass-123"
let app: Awaited<ReturnType<typeof startApp>>

before(async () => {
  stubDb((sql) => {
    if (sql.includes("FROM lms_settings")) return [{ value: crypto.createHash("sha256").update(PASSWORD).digest("hex") }]
    if (sql.includes("INSERT INTO lms_platform_sessions")) return []
    return undefined
  })
  app = await startApp((a) => {
    a.use("/api", sinovGuard)
    a.use("/api/sinov", sinovRoutes)
    // Guard o'tkazib yuborgan so'rovlar shu yerga yetadi
    a.all(/^\/api\/.*/, (_req, res) => { res.json({ passed: true }) })
  })
})
after(() => app.close())

const login = (password: string) =>
  fetch(`${app.base}/api/sinov/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: "sinov.talaba", password }),
  })

async function studentToken(): Promise<string> {
  const res = await login(PASSWORD)
  assert.equal(res.status, 200)
  return ((await res.json()) as { token: string }).token
}

test("noto'g'ri parol — 401", async () => {
  assert.equal((await login("xato")).status, 401)
})

test("sinov talabasi tokeni: sinov guruhidagi talaba", async () => {
  const [, payload] = (await studentToken()).split(".")
  const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>
  assert.equal(data.role, "student")
  assert.equal(data.groupId, SINOV_GROUP_ID)
  assert.equal(data.sinov, true)
})

test("HEMIS: profil soxta, o'qish bo'sh, yozish taqiqlangan; boshqa API'lar o'tadi", async () => {
  const auth = { Authorization: `Bearer ${await studentToken()}` }
  const me = (await (await fetch(`${app.base}/api/hemis/me`, { headers: auth })).json()) as { data: { group: { id: number } } }
  assert.equal(me.data.group.id, SINOV_GROUP_ID)
  const perf = (await (await fetch(`${app.base}/api/hemis/performance`, { headers: auth })).json()) as { data: unknown[] }
  assert.deepEqual(perf.data, [])
  assert.equal((await fetch(`${app.base}/api/hemis/anything`, { method: "POST", headers: auth })).status, 403)
  assert.deepEqual(await (await fetch(`${app.base}/api/teaching/content`, { headers: auth })).json(), { passed: true })
})

test("oddiy foydalanuvchi tokeniga tegmaydi", async () => {
  const res = await fetch(`${app.base}/api/hemis/me`, { headers: { Authorization: `Bearer ${token({ id: 5, role: "student" })}` } })
  assert.deepEqual(await res.json(), { passed: true })
})
