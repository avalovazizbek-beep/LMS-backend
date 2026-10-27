import "./setup"
import { createHash } from "crypto"
// Test hisobi sozlamalari zoomReview.ts yuklanishidan oldin (sinov qiymatlari)
process.env.ZOOM_REVIEW_LOGIN = "zoom.reviewer"
process.env.ZOOM_REVIEW_PASSWORD_SHA256 = createHash("sha256").update("Test-Pass-123").digest("hex")

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { stubDb, token, startApp } from "./helpers"
import zoomRoutes from "../src/routes/zoom"
import { zoomReviewGuard, ZOOM_REVIEW_GROUP_ID } from "../src/services/zoomReview"

/* Zoom Marketplace test hisobi: login, sandbox va API allowlist. Guard
   o'tkazib yuborgan so'rovlar uchun "passed" javobini beruvchi soxta
   route — guard'ning o'zini route'lardan ajratib tekshiradi. */

let app: Awaited<ReturnType<typeof startApp>>
let inserts: unknown[][] = []

before(async () => {
  stubDb((sql, params) => {
    if (sql.includes("INSERT INTO lms_groups") || sql.includes("INSERT IGNORE INTO lms_teacher_groups")) {
      inserts.push(params)
      return []
    }
    if (sql.includes("FROM zoom_connections")) return []
    return undefined
  })
  app = await startApp((a) => {
    a.use("/api", zoomReviewGuard)
    a.use("/api/integrations/zoom", zoomRoutes)
    a.all("/api/*", (_req, res) => { res.json({ passed: true }) })
  })
})
after(async () => { await app.close() })

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })

async function reviewToken(): Promise<string> {
  const res = await post("/api/integrations/zoom/review-login", { login: "Zoom.Reviewer", password: "Test-Pass-123" })
  assert.equal(res.status, 200)
  const data = await res.json() as { token: string; role: string }
  assert.equal(data.role, "employee")
  return data.token
}

test("review-login: noto'g'ri parol 401, to'g'risi token va sandbox guruh", async () => {
  const bad = await post("/api/integrations/zoom/review-login", { login: "zoom.reviewer", password: "wrong" })
  assert.equal(bad.status, 401)
  inserts = []
  await reviewToken()
  assert.ok(inserts.some((p) => p.includes(ZOOM_REVIEW_GROUP_ID)), "sandbox guruh yozilmadi")
})

test("guard: faqat Zoom oqimi API'lari ochiq, qolgani 403", async () => {
  const auth = { Authorization: `Bearer ${await reviewToken()}` }
  for (const path of ["/api/meetings", "/api/integrations/zoom/status", "/api/teaching/groups", "/api/notifications", "/api/photos/me", "/api/admin/check"]) {
    const res = await fetch(`${app.base}${path}`, { headers: auth })
    assert.equal(res.status, 200, path)
  }
  for (const path of ["/api/hemis/employee/attendance-journal", "/api/photos/student/123", "/api/teaching/content", "/api/admin/users", "/api/announcements/mine", "/api/face/status"]) {
    const res = await fetch(`${app.base}${path}`, { headers: auth })
    assert.equal(res.status, 403, path)
  }
  // ?token= bilan ham (fayl havolalari) o'sha cheklov
  const viaQuery = await fetch(`${app.base}/api/photos/student/123?token=${encodeURIComponent(auth.Authorization.slice(7))}`)
  assert.equal(viaQuery.status, 403)
})

test("guard: employee-me HEMIS'siz test profilini qaytaradi", async () => {
  const res = await fetch(`${app.base}/api/hemis/employee-me`, { headers: { Authorization: `Bearer ${await reviewToken()}` } })
  assert.equal(res.status, 200)
  const data = await res.json() as { data: { full_name: string }; source: string }
  assert.equal(data.source, "zoom-review")
  assert.match(data.data.full_name, /Zoom Reviewer/)
})

test("guard: meeting faqat sandbox guruhga yaratiladi", async () => {
  const auth = { Authorization: `Bearer ${await reviewToken()}` }
  const real = await post("/api/meetings", { title: "x", groupIds: [865] }, auth)
  assert.equal(real.status, 403)
  const mixed = await post("/api/meetings", { title: "x", groupIds: [ZOOM_REVIEW_GROUP_ID, 865] }, auth)
  assert.equal(mixed.status, 403)
  const sandbox = await post("/api/meetings", { title: "x", groupIds: [ZOOM_REVIEW_GROUP_ID] }, auth)
  assert.equal(sandbox.status, 200)
})

test("guard: oddiy foydalanuvchilarga tegmaydi", async () => {
  const teacher = { Authorization: `Bearer ${token({ id: 500, role: "employee" })}` }
  const res = await fetch(`${app.base}/api/photos/student/123`, { headers: teacher })
  assert.equal(res.status, 200)
  const meeting = await post("/api/meetings", { title: "x", groupIds: [865] }, teacher)
  assert.equal(meeting.status, 200)
})
