import fs from "fs"
import path from "path"
import type mysql from "mysql2/promise"
import { pool, fromMysqlDate } from "./db"
import { notifySafe } from "./notificationStore"

/* ── O'qituvchi tashakkurnomasi ─────────────────────────────────────────
   "Fan resurslari"da yetarli mavzuni to'liq to'ldirgan o'qituvchiga bir marta
   beriladi. Talab (admin sozlamalarida o'zgaradi, lms_settings):
     certificate_auto        — avtomatik berish yoqilganmi ("1"/"0")
     certificate_topic_goal  — nechta to'liq mavzu kerak (standart 15)
     certificate_parts       — to'liq mavzuda bo'lishi shart qismlar:
       media        — video YOKI audio (fayli bilan) yoki YouTube havolasi
       presentation — taqdimot (theory) fayli
       guide        — qo'llanma fayli
       check        — test (kamida 1 savol) YOKI topshiriq
     certificate_template    — admin yuklagan shablon fayli (bo'sh — standart)
   O'qituvchiga progress ko'rsatilmaydi — tashakkurnoma kutilmagan sovg'a
   bo'lib chiqishi uchun; hisob orqa fonda (sweepCertificates) yuradi. ── */
export type TopicPart = "media" | "presentation" | "guide" | "check"
export const TOPIC_PARTS: TopicPart[] = ["media", "presentation", "guide", "check"]
const DEFAULT_GOAL = 15

export interface CertificateConfig {
  auto: boolean
  goal: number
  parts: TopicPart[]
  hasCustomTemplate: boolean
}

export interface TeacherCertificate {
  fullName: string
  completedTopics: number
  issuedAt: string
}

interface CertificateRow extends TeacherCertificate {
  issuedBy: string | null
  revokedAt: string | null
}

export interface AdminCertificateItem {
  teacherUserId: number
  fullName: string
  completedTopics: number
  certificate: { issuedAt: string; issuedBy: string | null; revoked: boolean } | null
}

/* ── Sozlamalar ─────────────────────────────────────────────────────── */
export function parseParts(value: unknown): TopicPart[] {
  const list = String(value ?? "").split(",").map((s) => s.trim())
  return TOPIC_PARTS.filter((p) => list.includes(p))
}

async function readSettings(): Promise<Record<string, string>> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT key_name, value FROM lms_settings
      WHERE key_name IN ('certificate_auto', 'certificate_topic_goal', 'certificate_parts', 'certificate_template')`
  )
  return Object.fromEntries(rows.map((r) => [String(r.key_name), String(r.value)]))
}

export async function getCertificateConfig(): Promise<CertificateConfig> {
  const raw = await readSettings()
  const goal = Number(raw.certificate_topic_goal)
  const parts = parseParts(raw.certificate_parts)
  return {
    auto: raw.certificate_auto !== "0",
    goal: Number.isInteger(goal) && goal >= 1 ? goal : DEFAULT_GOAL,
    parts: parts.length ? parts : TOPIC_PARTS,
    hasCustomTemplate: Boolean(raw.certificate_template) && fs.existsSync(templatePath(raw.certificate_template)),
  }
}

/* ── Ism ────────────────────────────────────────────────────────────── */
/** "Familiya Ism" — HEMIS ismlarni katta harflarda beradi (MIRZAYEV KULMAMAT
    DJANZAKOVICH); otasining ismi tashakkurnoma qatoriga sig'maydi. */
export function certificateDisplayName(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.toLowerCase().replace(/(^|-)(\S)/g, (_m, sep: string, ch: string) => sep + ch.toUpperCase()))
    .join(" ")
}

/** O'qituvchi ID'lari bo'yicha ism: avval HEMIS xodimlar katalogi, keyin login keshi */
async function directoryNames(ids: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  if (!ids.length) return names
  const [cached] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT teacher_user_id AS id, full_name FROM hemis_users WHERE role = 'employee' AND teacher_user_id IN (?) AND full_name IS NOT NULL",
    [ids]
  )
  for (const r of cached) names.set(Number(r.id), certificateDisplayName(String(r.full_name)))
  const [dir] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT hemis_id AS id, full_name FROM hemis_employees_directory WHERE hemis_id IN (?)",
    [ids]
  )
  for (const r of dir) names.set(Number(r.id), certificateDisplayName(String(r.full_name)))
  return names
}

/* ── To'liq mavzular hisobi ─────────────────────────────────────────── */
function partOf(row: mysql.RowDataPacket): TopicPart | null {
  const hasFile = Number(row.has_file) > 0
  if (row.type === "exam") return Number(row.question_count) > 0 ? "check" : null
  if (row.type === "assignment") return hasFile || Number(row.has_description) > 0 ? "check" : null
  if (row.type !== "mavzu") return null
  switch (row.kind) {
    case "video_lesson":
    case "audio":
      return hasFile ? "media" : null
    case "youtube":
      return String(row.meeting_link ?? "").trim() ? "media" : null
    case "theory":
      return hasFile ? "presentation" : null
    case "qollanma":
      return hasFile ? "guide" : null
    default:
      return null
  }
}

async function loadTopicRows(filter: { teacherUserId?: number; uncertifiedOnly?: boolean }) {
  const where = ["c.topic_key IS NOT NULL", "c.is_active = 1"]
  const params: unknown[] = []
  if (filter.teacherUserId != null) {
    where.push("c.teacher_user_id = ?")
    params.push(filter.teacherUserId)
  }
  // Bekor qilingan (revoked) yozuv ham "bor" hisoblanadi — admin bekor qilgan
  // tashakkurnoma orqa fonda qayta berilib qolmasligi uchun
  if (filter.uncertifiedOnly) {
    where.push("NOT EXISTS (SELECT 1 FROM lms_teacher_certificates tc WHERE tc.teacher_user_id = c.teacher_user_id)")
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT c.teacher_user_id, c.type, c.kind, c.topic_key, c.subject_name, c.title, c.training_type, c.meeting_link,
            (c.description IS NOT NULL AND TRIM(c.description) <> '') AS has_description,
            (c.file_name IS NOT NULL OR EXISTS (SELECT 1 FROM lms_teacher_content_files f WHERE f.content_id = c.id)) AS has_file,
            (SELECT COUNT(*) FROM lms_exam_questions q WHERE q.content_id = c.id) AS question_count
       FROM lms_teacher_content c
      WHERE ${where.join(" AND ")}`,
    params
  )
  return rows
}

interface TopicInstance {
  teacherUserId: number
  subjectName: string
  title: string
  trainingType: string | null
  hasMarker: boolean
  parts: Set<TopicPart>
}

/** O'qituvchi → to'liq mavzular soni (mavzusi bor har bir o'qituvchi, 0 bo'lsa ham).
    Bitta mavzu parallel guruhlarga nusxalangan bo'lsa BITTA sanaladi (fan + tur +
    nom bo'yicha) — aks holda bitta mavzuni 15 guruhga nusxalash yetarli bo'lardi. */
function countCompleteTopics(rows: mysql.RowDataPacket[], required: TopicPart[]): Map<number, number> {
  const instances = new Map<string, TopicInstance>()
  for (const row of rows) {
    const key = String(row.topic_key)
    let inst = instances.get(key)
    if (!inst) {
      inst = {
        teacherUserId: Number(row.teacher_user_id),
        subjectName: String(row.subject_name),
        title: String(row.title),
        trainingType: row.training_type ?? null,
        hasMarker: false,
        parts: new Set(),
      }
      instances.set(key, inst)
    }
    // Mavzu nomi va turi marker'dan (teachingStore.topicTrainingType bilan bir xil)
    if (row.type === "mavzu" && row.kind === "topic") {
      inst.title = String(row.title)
      inst.trainingType = row.training_type ?? null
      inst.hasMarker = true
      continue
    }
    if (!inst.hasMarker && !inst.trainingType && row.training_type) inst.trainingType = row.training_type
    const part = partOf(row)
    if (part) inst.parts.add(part)
  }

  const complete = new Map<number, Set<string>>()
  for (const inst of instances.values()) {
    if (!complete.has(inst.teacherUserId)) complete.set(inst.teacherUserId, new Set())
    if (!required.every((p) => inst.parts.has(p))) continue
    const id = [inst.subjectName, inst.trainingType ?? "", inst.title].map((s) => s.trim().toLowerCase()).join("|")
    complete.get(inst.teacherUserId)!.add(id)
  }
  return new Map(Array.from(complete, ([teacher, ids]) => [teacher, ids.size]))
}

/* ── Tashakkurnoma yozuvlari ────────────────────────────────────────── */
function mapCertificateRow(row: mysql.RowDataPacket): CertificateRow {
  return {
    fullName: String(row.full_name),
    completedTopics: Number(row.completed_topics),
    issuedAt: fromMysqlDate(row.issued_at),
    issuedBy: row.issued_by ?? null,
    revokedAt: row.revoked_at ? fromMysqlDate(row.revoked_at) : null,
  }
}

async function getCertificateRow(teacherUserId: number): Promise<CertificateRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_teacher_certificates WHERE teacher_user_id = ? LIMIT 1",
    [teacherUserId]
  )
  return rows.length ? mapCertificateRow(rows[0]) : null
}

function notifyIssued(teacherUserId: number) {
  notifySafe({
    role: "employee",
    userId: teacherUserId,
    type: "system",
    title: "Tabriklaymiz! Sizga tashakkurnoma berildi",
    body: "Fan resurslarini to'ldirishdagi mehnatingiz uchun. Uni bosh sahifadan yuklab olishingiz mumkin.",
    link: "/dashboard",
    i18nKey: "certificateIssued",
  })
}

/** Avtomatik berish — yozuv umuman yo'q bo'lsagina (bekor qilingani qayta tiklanmaydi) */
async function issueAutomatically(teacherUserId: number, fullName: string, completedTopics: number): Promise<boolean> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    "INSERT IGNORE INTO lms_teacher_certificates (teacher_user_id, full_name, completed_topics) VALUES (?, ?, ?)",
    [teacherUserId, fullName, completedTopics]
  )
  if (result.affectedRows > 0) notifyIssued(teacherUserId)
  return result.affectedRows > 0
}

/** O'qituvchi: o'z tashakkurnomasi (berilmagan yoki bekor qilingan — null).
    Shartga yetgan bo'lsa shu yerda ham beriladi — orqa fondagi tekshiruvni
    kutmasdan, mavzuni tugatgan zahoti ko'rinishi uchun. */
export async function teacherCertificate(teacherUserId: number, fullName: string): Promise<TeacherCertificate | null> {
  let row = await getCertificateRow(teacherUserId)
  if (!row) {
    const config = await getCertificateConfig()
    if (config.auto) {
      const count = countCompleteTopics(await loadTopicRows({ teacherUserId }), config.parts).get(teacherUserId) ?? 0
      if (count >= config.goal) {
        await issueAutomatically(teacherUserId, fullName, count)
        row = await getCertificateRow(teacherUserId)
      }
    }
  }
  if (!row || row.revokedAt) return null
  // Ism keyinroq aniqroq bo'lib qolishi mumkin — sana o'zgarmaydi, faqat ism
  if (fullName && row.fullName !== fullName) {
    await pool.query("UPDATE lms_teacher_certificates SET full_name = ? WHERE teacher_user_id = ?", [fullName, teacherUserId])
    row = { ...row, fullName }
  }
  return { fullName: row.fullName, completedTopics: row.completedTopics, issuedAt: row.issuedAt }
}

let sweeping = false

/** Orqa fon: shartga yetgan, hali yozuvi yo'q barcha o'qituvchilarga beradi */
export async function sweepCertificates(): Promise<number> {
  if (sweeping) return 0
  sweeping = true
  try {
    const config = await getCertificateConfig()
    if (!config.auto) return 0
    const counts = countCompleteTopics(await loadTopicRows({ uncertifiedOnly: true }), config.parts)
    const eligible = Array.from(counts).filter(([, n]) => n >= config.goal)
    if (!eligible.length) return 0
    const names = await directoryNames(eligible.map(([id]) => id))
    let issued = 0
    for (const [id, n] of eligible) {
      if (await issueAutomatically(id, names.get(id) ?? "", n)) issued++
    }
    if (issued) console.log(`[certificate] ${issued} ta o'qituvchiga tashakkurnoma berildi`)
    return issued
  } finally {
    sweeping = false
  }
}

export function startCertificateSweep(intervalMs = 10 * 60 * 1000) {
  const run = () => {
    sweepCertificates().catch((err) => console.warn("[certificate] tekshiruv xatosi:", (err as Error)?.message ?? err))
  }
  setTimeout(run, 60_000)
  setInterval(run, intervalMs)
}

/* ── Admin ──────────────────────────────────────────────────────────── */
export async function listCertificatesForAdmin(q: string): Promise<AdminCertificateItem[]> {
  const config = await getCertificateConfig()
  const counts = countCompleteTopics(await loadTopicRows({}), config.parts)
  const [certRows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_teacher_certificates")
  const certs = new Map(certRows.map((r) => [Number(r.teacher_user_id), mapCertificateRow(r)]))

  const ids = new Set<number>([...counts.keys(), ...certs.keys()])
  const query = q.trim()
  if (query) {
    const [found] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT hemis_id FROM hemis_employees_directory WHERE is_active = 1 AND full_name LIKE ? LIMIT 50",
      [`%${query}%`]
    )
    for (const r of found) ids.add(Number(r.hemis_id))
  }
  const names = await directoryNames(Array.from(ids))

  const needle = query.toLowerCase()
  return Array.from(ids)
    .map((id) => {
      const cert = certs.get(id)
      return {
        teacherUserId: id,
        fullName: cert?.fullName || names.get(id) || "",
        completedTopics: counts.get(id) ?? 0,
        certificate: cert ? { issuedAt: cert.issuedAt, issuedBy: cert.issuedBy, revoked: cert.revokedAt !== null } : null,
      }
    })
    .filter((item) => !needle || item.fullName.toLowerCase().includes(needle))
    .sort((a, b) => b.completedTopics - a.completedTopics || a.fullName.localeCompare(b.fullName))
}

export type ManualIssueResult = "issued" | "already" | "no-name"

export async function issueCertificateManually(teacherUserId: number, issuedBy: string): Promise<ManualIssueResult> {
  const existing = await getCertificateRow(teacherUserId)
  if (existing && !existing.revokedAt) return "already"
  const name = (await directoryNames([teacherUserId])).get(teacherUserId) || existing?.fullName || ""
  if (!name) return "no-name"
  const config = await getCertificateConfig()
  const count = countCompleteTopics(await loadTopicRows({ teacherUserId }), config.parts).get(teacherUserId) ?? 0
  await pool.query(
    `INSERT INTO lms_teacher_certificates (teacher_user_id, full_name, completed_topics, issued_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), completed_topics = VALUES(completed_topics),
       issued_by = VALUES(issued_by), issued_at = CURRENT_TIMESTAMP, revoked_at = NULL`,
    [teacherUserId, name, count, issuedBy]
  )
  notifyIssued(teacherUserId)
  return "issued"
}

export async function revokeCertificate(teacherUserId: number): Promise<boolean> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    "UPDATE lms_teacher_certificates SET revoked_at = CURRENT_TIMESTAMP WHERE teacher_user_id = ? AND revoked_at IS NULL",
    [teacherUserId]
  )
  return result.affectedRows > 0
}

/* ── Shablon (admin yuklagan rasm) ──────────────────────────────────── */
const STORAGE_ROOT = path.resolve(process.env.LOCAL_RESOURCE_STORAGE || path.join(process.cwd(), "storage"))
const TEMPLATE_DIR = path.join(STORAGE_ROOT, "certificates")

// Fayl nomi faqat server yaratgan qiymat (lms_settings) — basename yo'ldan chiqib ketishni to'sadi
function templatePath(name: string) {
  return path.join(TEMPLATE_DIR, path.basename(name))
}

const TEMPLATE_TYPES: { ext: string; mime: string; magic: (b: Buffer) => boolean }[] = [
  { ext: ".png", mime: "image/png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".jpg", mime: "image/jpeg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".webp", mime: "image/webp", magic: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
]

export async function getCustomTemplate(): Promise<{ filePath: string; mimeType: string } | null> {
  const name = (await readSettings()).certificate_template
  if (!name) return null
  const filePath = templatePath(name)
  if (!fs.existsSync(filePath)) return null // nosemgrep
  const type = TEMPLATE_TYPES.find((t) => t.ext === path.extname(filePath).toLowerCase())
  return { filePath, mimeType: type?.mime ?? "application/octet-stream" }
}

async function setTemplateSetting(name: string | null) {
  const previous = (await readSettings()).certificate_template
  if (name) {
    await pool.query(
      "INSERT INTO lms_settings (key_name, value) VALUES ('certificate_template', ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [name]
    )
  } else {
    await pool.query("DELETE FROM lms_settings WHERE key_name = 'certificate_template'")
  }
  if (previous && previous !== name) await fs.promises.rm(templatePath(previous), { force: true }) // nosemgrep
}

/** Rasm turini mazmunidan (magic bytes) aniqlaydi — sarlavhaga ishonilmaydi */
export async function saveCustomTemplate(body: Buffer): Promise<boolean> {
  const type = TEMPLATE_TYPES.find((t) => t.magic(body))
  if (!type) return false
  await fs.promises.mkdir(TEMPLATE_DIR, { recursive: true })
  const name = `template-${Date.now()}${type.ext}`
  await fs.promises.writeFile(templatePath(name), body) // nosemgrep
  await setTemplateSetting(name)
  return true
}

export async function resetCustomTemplate(): Promise<void> {
  await setTemplateSetting(null)
}
