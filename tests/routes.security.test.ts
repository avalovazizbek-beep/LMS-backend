import { STORAGE, stubDb, token, startApp, rawGet, PNG_1PX } from "./helpers"
import { test, before, after, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import hemisRoutes from "../src/routes/hemis"
import teachingRoutes from "../src/routes/teaching"

/* Marshrut darajasidagi testlar: path traversal, ruxsatlar, MIME.
   Baza stub qilingan — har bir test o'ziga kerakli qatorlarni beradi. */

const TEACHER = token({ id: 500, role: "employee" })            // mavzu egasi, guruh 77
const GROUP_TEACHER = token({ id: 601, role: "employee" })      // guruh 77 da dars beradi
const OTHER_TEACHER = token({ id: 600, role: "employee" })      // guruh 77 ga aloqasi yo'q
const STUDENT_77 = token({ id: 900, role: "student", groupId: 77 })
const STUDENT_78 = token({ id: 901, role: "student", groupId: 78 })
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

const GROUPS_BY_TEACHER: Record<number, number[]> = { 500: [77], 601: [77], 600: [12] }

let app: Awaited<ReturnType<typeof startApp>>
let queries: string[] = []
let legacyReferenced = new Set<string>()
let hemisSubmissions: Record<string, { original_name: string; mime_type: string; group_id: number }> = {}
let inserts: unknown[][] = []

const CONTENT_ROW = {
  id: 5, uuid: "u-5", type: "lesson", teacher_user_id: 500, group_id: 77, subject_name: "Fan", title: "Mavzu",
  file_name: "slides.pptx", original_name: "slides.pptx", mime_type: "application/octet-stream", file_size: 1,
  relative_path: "/teaching/not-on-disk.pptx", available_from: new Date(Date.now() - 86_400_000), deadline: null, is_active: 1,
}

function defaultDb(sql: string, params: unknown[]) {
  queries.push(sql)
  if (sql.includes("FROM lms_teacher_content WHERE id = ?")) return Number(params[0]) === 5 ? [CONTENT_ROW] : []
  if (sql.includes("FROM lms_teacher_content_files")) return []
  if (sql.includes("FROM lms_teacher_groups")) return (GROUPS_BY_TEACHER[Number(params[0])] ?? []).map((group_id) => ({ group_id }))
  if (sql.includes("SELECT 1 FROM lms_exam_questions WHERE image_url LIKE")) {
    const like = String(params[0])
    return [...legacyReferenced].some((n) => like === `%/question-image/${n.replace(/[\\%_]/g, (c) => `\\${c}`)}`) ? [{ 1: 1 }] : []
  }
  if (sql.includes("FROM lms_hemis_task_submissions WHERE file_name = ?")) {
    const row = hemisSubmissions[String(params[0])]
    return row ? [row] : []
  }
  if (sql.includes("INSERT INTO lms_hemis_task_submissions")) { inserts.push(params); return [] }
  return undefined
}

before(async () => {
  app = await startApp((a) => {
    a.use("/api/hemis", hemisRoutes)
    a.use("/api/teaching", teachingRoutes)
  })
})
after(async () => { await app.close() })
beforeEach(() => {
  queries = []
  inserts = []
  legacyReferenced = new Set()
  hemisSubmissions = {}
  stubDb(defaultDb)
})

/* ── GET /api/hemis/task-submission-file/:filename ── */

test("hemis fayl: traversal nomlari diskka va bazaga tegmasdan 400", async () => {
  const outside = path.join(STORAGE, "private", "outside-secret.txt")
  fs.mkdirSync(path.dirname(outside), { recursive: true })
  fs.writeFileSync(outside, "maxfiy")
  for (const raw of ["..%2F..%2Foutside-secret.txt", "..%2Foutside-secret.txt", "%2e%2e%2f%2e%2e%2fpackage.json", "..%5C..%5Coutside-secret.txt", "%2Fetc%2Fpasswd", ".env", "C%3A%5Cwindows%5Cwin.ini"]) {
    const r = await rawGet(app.base, `/api/hemis/task-submission-file/${raw}`, auth(TEACHER))
    assert.equal(r.status, 400, raw)
    assert.ok(!r.body.includes("maxfiy"), raw)
  }
  assert.equal(queries.length, 0, "yaroqsiz nomda baza so'rovi bo'lmasligi kerak")
})

test("hemis fayl: ruxsat va bazadagi yozuv diskdan oldin tekshiriladi", async () => {
  const dir = path.join(STORAGE, "private", "submissions", "hemis")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "report-1-ab12cd34.html"), "<script>alert(1)</script>")

  // yozuv yo'q → 404
  let r = await rawGet(app.base, "/api/hemis/task-submission-file/report-1-ab12cd34.html", auth(TEACHER))
  assert.equal(r.status, 404)

  // boshqa guruh → 403
  hemisSubmissions["report-1-ab12cd34.html"] = { original_name: "report.html", mime_type: "text/html", group_id: 99 }
  r = await rawGet(app.base, "/api/hemis/task-submission-file/report-1-ab12cd34.html", auth(TEACHER))
  assert.equal(r.status, 403)

  // talaba → 403
  r = await rawGet(app.base, "/api/hemis/task-submission-file/report-1-ab12cd34.html", auth(STUDENT_77))
  assert.equal(r.status, 403)

  // o'z guruhi → 200, lekin text/html emas (bazadagi mijoz MIME'i ishlatilmaydi)
  hemisSubmissions["report-1-ab12cd34.html"].group_id = 77
  r = await rawGet(app.base, "/api/hemis/task-submission-file/report-1-ab12cd34.html", auth(TEACHER))
  assert.equal(r.status, 200)
  assert.equal(r.headers["content-type"], "application/octet-stream")
  assert.equal(r.headers["x-content-type-options"], "nosniff")
  assert.match(String(r.headers["content-disposition"]), /^attachment;/)

  // yozuv bor, fayl diskda yo'q → 404
  hemisSubmissions["gone-1-ab12cd34.pdf"] = { original_name: "gone.pdf", mime_type: "application/pdf", group_id: 77 }
  r = await rawGet(app.base, "/api/hemis/task-submission-file/gone-1-ab12cd34.pdf", auth(TEACHER))
  assert.equal(r.status, 404)
})

/* ── POST /api/hemis/task-submit ── */

test("hemis topshiriq: fayl nomi orqali papkadan chiqib bo'lmaydi, MIME kengaytmadan", async () => {
  const res = await fetch(`${app.base}/api/hemis/task-submit`, {
    method: "POST",
    headers: { ...auth(STUDENT_77), "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: "t1", filename: "../../../escape.html", file_type: "text/html", file_data: Buffer.from("<b>x</b>").toString("base64") }),
  })
  assert.equal(res.status, 200)
  assert.equal(fs.existsSync(path.join(STORAGE, "escape.html")), false)
  assert.equal(fs.existsSync(path.join(STORAGE, "private", "escape.html")), false)
  assert.equal(inserts.length, 1)
  const [, , , , savedName, originalName, mimeType] = inserts[0] as string[]
  assert.match(savedName, /^escape-\d+-[0-9a-f]{8}\.html$/)
  assert.equal(originalName, "../../../escape.html")
  assert.equal(mimeType, "application/octet-stream", "mijoz yuborgan text/html saqlanmasligi kerak")
  assert.ok(fs.existsSync(path.join(STORAGE, "private", "submissions", "hemis", savedName)))
})

/* ── Savol rasmlari ── */

async function uploadImage(t: string, filename: string, body: Buffer) {
  return fetch(`${app.base}/api/teaching/question-image?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { ...auth(t), "Content-Type": "application/octet-stream" },
    body,
  })
}

test("savol rasmi yuklash: faqat haqiqiy rasm, nom serverda tuziladi", async () => {
  assert.equal((await uploadImage(TEACHER, "x.png", Buffer.from("<svg onload=alert(1)></svg>"))).status, 400, "rasm emas")
  assert.equal((await uploadImage(TEACHER, "x.pdf", PNG_1PX)).status, 400, "rasm kengaytmasi emas")
  assert.equal((await uploadImage(TEACHER, "x.svg", PNG_1PX)).status, 400, "svg qabul qilinmaydi")
  assert.equal((await uploadImage(STUDENT_77, "x.png", PNG_1PX)).status, 403, "talaba yuklay olmaydi")

  const res = await uploadImage(TEACHER, "../../../../evil.png", PNG_1PX)
  assert.equal(res.status, 200)
  const { data } = await res.json() as { data: { url: string } }
  const name = data.url.split("/").pop()!
  assert.match(name, /^\d+-[0-9a-f]{16}\.png$/)
  assert.ok(fs.existsSync(path.join(STORAGE, "question-images", name)))
  assert.equal(fs.existsSync(path.join(STORAGE, "evil.png")), false)

  const got = await rawGet(app.base, `/api/teaching/question-image/${name}`, auth(STUDENT_77))
  assert.equal(got.status, 200)
  assert.equal(got.headers["content-type"], "image/png")
  assert.equal(got.headers["x-content-type-options"], "nosniff")
  assert.ok(got.body.equals(PNG_1PX))
})

test("savol rasmi olish: traversal va rasm bo'lmagan nomlar 400, tokensiz 401", async () => {
  for (const raw of ["..%2F..%2F.env", "..%2Fprivate%2Fteaching%2Fa.png", "%2e%2e%5csecret.png", "x.pdf", "x.svg", ".env", "noext"]) {
    const r = await rawGet(app.base, `/api/teaching/question-image/${raw}`, auth(STUDENT_77))
    assert.equal(r.status, 400, raw)
  }
  assert.equal((await rawGet(app.base, "/api/teaching/question-image/a.png")).status, 401)
})

test("savol rasmi: eski papkadagi fayl faqat savolda ishlatilgan bo'lsa beriladi", async () => {
  const legacyDir = path.join(STORAGE, "private", "teaching")
  fs.mkdirSync(legacyDir, { recursive: true })
  fs.writeFileSync(path.join(legacyDir, "locked_test-1-ab12cd34.png"), PNG_1PX)

  // savolda ishlatilmagan (masalan yopiq mavzu fayli) → 404
  let r = await rawGet(app.base, "/api/teaching/question-image/locked_test-1-ab12cd34.png", auth(STUDENT_78))
  assert.equal(r.status, 404)

  // savolda ishlatilgan eski rasm → 200 (LIKE parametrida "_" ekranlangan)
  legacyReferenced.add("locked_test-1-ab12cd34.png")
  r = await rawGet(app.base, "/api/teaching/question-image/locked_test-1-ab12cd34.png", auth(STUDENT_78))
  assert.equal(r.status, 200)
  assert.equal(r.headers["content-type"], "image/png")
})

/* ── PPTX ko'rish endpointlari: o'qituvchi ruxsati ── */

test("pptx: begona o'qituvchi 403, egasi va guruh o'qituvchisi o'tadi", async () => {
  for (const endpoint of ["pptx-slides", "pptx-rich-slides"]) {
    const url = `/api/teaching/content/5/${endpoint}`
    assert.equal((await rawGet(app.base, url, auth(OTHER_TEACHER))).status, 403, `${endpoint} begona`)
    assert.equal((await rawGet(app.base, url, auth(STUDENT_78))).status, 403, `${endpoint} boshqa guruh talabasi`)
    for (const t of [TEACHER, GROUP_TEACHER, STUDENT_77]) {
      const r = await rawGet(app.base, url, auth(t))
      assert.equal(r.status, 200, endpoint)
      assert.deepEqual(JSON.parse(r.body.toString()), { count: 0, slides: [] }) // fayl diskda yo'q
    }
  }
  assert.equal((await rawGet(app.base, "/api/teaching/content/5/pptx-as-pdf", auth(OTHER_TEACHER))).status, 403)
  assert.equal((await rawGet(app.base, "/api/teaching/content/5/pptx-as-pdf", auth(TEACHER))).status, 404)
})
