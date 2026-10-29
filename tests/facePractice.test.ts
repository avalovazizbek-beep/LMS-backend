import "./setup"
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { stubDb, token, startApp } from "./helpers"
import faceRoutes, { practicePassed } from "../src/routes/face"

/* "Yuzni sinab ko'rish": oraliqdan oldingi demo test natijasi saqlanadi;
   o'tish qoidasi haqiqiy imtihondagidek — server o'zi qayta hisoblaydi. */

let calls: [string, unknown[]][] = []
let lastPassed: string | null = null
let app: Awaited<ReturnType<typeof startApp>>

before(async () => {
  stubDb((sql, params) => {
    calls.push([sql.replace(/\s+/g, " ").trim(), params])
    if (sql.includes("INSERT INTO face_practice_runs")) {
      if (params[1] === 1) lastPassed = "2026-10-28 10:00:00"
      return { insertId: 1 } as unknown as Record<string, unknown>[]
    }
    if (sql.includes("FROM face_practice_runs"))
      return [{ last_passed_at: lastPassed, last_at: "2026-10-28 10:00:00", runs: 1 }]
    return []
  })
  app = await startApp((a) => a.use("/api/face", faceRoutes))
})
after(() => app.close())

const auth = { Authorization: `Bearer ${token({ id: 4512, role: "student", hemisLogin: "3412311003" })}`, "Content-Type": "application/json" }
const send = (body: Record<string, unknown>) =>
  fetch(`${app.base}/api/face/practice`, { method: "POST", headers: auth, body: JSON.stringify(body) })

test("o'tish qoidasi: chegaradan kam xatolik va yuz tasdiqlangan", () => {
  assert.equal(practicePassed({ passed: true, violations: 2, maxViolations: 3, issues: ["no_face"] }), true)
  assert.equal(practicePassed({ passed: true, violations: 3, maxViolations: 3, issues: [] }), false)
  assert.equal(practicePassed({ passed: true, violations: 0, maxViolations: 3, issues: ["camera"] }), false)
  assert.equal(practicePassed({ passed: true, violations: 0, maxViolations: 3, issues: ["not_verified"] }), false)
  assert.equal(practicePassed({ passed: false, violations: 0, maxViolations: 3, issues: [] }), false)
})

test("hali sinov yo'q — o'tmagan", async () => {
  lastPassed = null
  const res = await fetch(`${app.base}/api/face/practice`, { headers: auth })
  assert.equal(res.status, 200)
  const body = await res.json() as { data: { passed: boolean } }
  assert.equal(body.data.passed, false)
  const [sql, params] = calls.find(([q]) => q.includes("FROM face_practice_runs"))!
  assert.match(sql, /WHERE username = \?/)
  assert.deepEqual(params, ["3412311003"])
})

test("chegaraga yetgan sinov 'o'tdi' deb yuborilsa ham o'tmagan deb yoziladi", async () => {
  calls = []
  lastPassed = null
  const res = await send({ passed: true, violations: 3, maxViolations: 3, confidence: 40, issues: ["mismatch", "boshqa"] })
  assert.equal(res.status, 200)
  const body = await res.json() as { data: { passed: boolean; passedNow: boolean } }
  assert.equal(body.data.passedNow, false)
  const [, params] = calls.find(([q]) => q.startsWith("INSERT INTO face_practice_runs"))!
  assert.deepEqual(params.slice(0, 6), ["3412311003", 0, 3, 3, 40, "mismatch"])
})

test("muammosiz sinov — o'tdi", async () => {
  lastPassed = null
  const res = await send({ passed: true, violations: 0, maxViolations: 3, confidence: 87, issues: [] })
  const body = await res.json() as { data: { passed: boolean; passedNow: boolean } }
  assert.equal(body.data.passedNow, true)
  assert.equal(body.data.passed, true)
})

test("noto'g'ri natija — 400", async () => {
  assert.equal((await send({ passed: "ha", violations: 0, maxViolations: 3, issues: [] })).status, 400)
  assert.equal((await send({ passed: true, violations: -1, maxViolations: 3, issues: [] })).status, 400)
  assert.equal((await send({ passed: true, violations: 0, maxViolations: 3, confidence: 150, issues: [] })).status, 400)
})

test("token bo'lmasa — 401", async () => {
  assert.equal((await fetch(`${app.base}/api/face/practice`)).status, 401)
})
