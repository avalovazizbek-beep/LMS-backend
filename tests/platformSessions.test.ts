import "./setup"
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { stubDb, token, startApp } from "./helpers"
import authRoutes from "../src/routes/auth"
import { recordPlatformSession } from "../src/services/attendanceStore"

/* "Kirish tarixi": chiqish vaqti va platformadagi daqiqalar — heartbeat
   (oxirgi faollik), logout (yopish), yangi kirishda eski ochiq sessiya yopiladi. */

let calls: [string, unknown[]][] = []
let app: Awaited<ReturnType<typeof startApp>>

before(async () => {
  stubDb((sql, params) => {
    calls.push([sql.replace(/\s+/g, " ").trim(), params])
    if (sql.includes("INSERT INTO lms_platform_sessions")) return { insertId: 7 } as unknown as Record<string, unknown>[]
    return []
  })
  app = await startApp((a) => a.use("/api/auth", authRoutes))
})
after(() => app.close())

const post = (path: string, payload: Record<string, unknown>) =>
  fetch(`${app.base}/api/auth/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token(payload)}` } })

test("heartbeat talabaning so'nggi ochiq sessiyasini yangilaydi", async () => {
  calls = []
  assert.equal((await post("heartbeat", { id: 4512, role: "student", hemisToken: "x" })).status, 200)
  const [sql, params] = calls.find(([q]) => q.startsWith("UPDATE lms_platform_sessions"))!
  assert.match(sql, /SET last_seen_at = NOW\(\)/)
  assert.match(sql, /logout_at IS NULL ORDER BY login_at DESC LIMIT 1/)
  assert.deepEqual(params, [4512, "student"])
})

test("logout xodim sessiyasini yopadi", async () => {
  calls = []
  assert.equal((await post("logout", { id: 771, role: "employee", hemisToken: "x" })).status, 200)
  const [sql, params] = calls.find(([q]) => q.startsWith("UPDATE lms_platform_sessions"))!
  assert.match(sql, /SET logout_at = NOW\(\)/)
  assert.deepEqual(params, [771, "employee"])
})

test("token bo'lmasa — 401", async () => {
  assert.equal((await fetch(`${app.base}/api/auth/heartbeat`, { method: "POST" })).status, 401)
})

test("yangi kirish chiqilmay qolgan oldingi sessiyani oxirgi faollikda yopadi", async () => {
  calls = []
  const id = await recordPlatformSession(4512, "Talaba", 865, "student")
  assert.equal(id, 7)
  const close = calls.findIndex(([q]) => q.startsWith("UPDATE lms_platform_sessions SET logout_at = last_seen_at"))
  const insert = calls.findIndex(([q]) => q.startsWith("INSERT INTO lms_platform_sessions"))
  assert.ok(close >= 0 && close < insert)
  assert.match(calls[close][0], /last_seen_at = last_seen_at/)
  // Faollik signali kelmagan sessiya yopilmaydi (chiqish = kirish bo'lib qolmasin)
  assert.match(calls[close][0], /last_seen_at > login_at/)
})
