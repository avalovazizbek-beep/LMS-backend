import { randomUUID } from "crypto"
import type { RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise"
import { pool, toMysqlDate } from "./db"

/* ── So'rovnomalar ─────────────────────────────────────────────────────
   Admin yoki dekanat yaratadi, talaba va/yoki o'qituvchilar ixtiyoriy
   to'ldiradi (LMS'ning boshqa qismlarini hech narsa to'smaydi).

   Auditoriya: e'lon qilinganda qoidalar (lms_survey_targets) bo'yicha
   aniq odamlar ro'yxati lms_survey_participations'ga yoziladi — shu ro'yxat
   "kimga ko'rinadi", "kim javob berdi/bermadi" va eslatmalarning manbai.
   Faol so'rovnomada ro'yxat har 30 daqiqada yangilanadi (HEMIS'dan yangi
   kelgan talabalar qo'shiladi).

   LMS faqat masofaviy ta'lim uchun: talabalar — HEMIS katalogidagi faol
   masofaviy talabalar (education_form_code = '16'); o'qituvchilar — shu
   guruhlarda dars beradigan xodimlar (lms_teacher_groups / schedule / content).

   Anonimlik: javob qatori (lms_survey_responses) — tasodifiy UUID, user_id,
   ism va vaqtsiz; faqat rol, fakultet va kurs saqlanadi. Natijada 5 tadan
   kam javobli kesim ko'rsatilmaydi (ANON_MIN_GROUP). */

export const SURVEY_TYPES: Record<string, string> = {
  umumiy: "Umumiy",
  talim_sifati: "Ta'lim sifati",
  oqituvchi: "O'qituvchi faoliyati",
  qoniqish: "Qoniqish darajasi",
  tadbir: "Tadbir / voqea",
  boshqa: "Boshqa",
}

export const QUESTION_TYPES = ["single", "multiple", "text", "scale", "yesno", "rating"] as const
export type QuestionType = typeof QUESTION_TYPES[number]
export type AudienceKind = "student" | "teacher"
export type ParticipantRole = "student" | "employee"
export type SurveyState = "draft" | "scheduled" | "active" | "paused" | "finished" | "archived"

/** Anonim so'rovnomada bundan kam javobli kesim (fakultet/kurs) ko'rsatilmaydi */
export const ANON_MIN_GROUP = 5
/** HEMIS'da uchramaydigan demo/sinov ID'lari (sinovIds.ts, zoomReview.ts) */
const RESERVED_ID_MIN = 990_000_000
const MASOFAVIY_FORM = "16"
const AUDIENCE_RESYNC_MS = 30 * 60_000
const LIMITS = { title: 255, description: 5000, question: 2000, option: 500, answerText: 5000, questions: 100, options: 30, rules: 20 }

export interface TargetRule {
  audience: AudienceKind
  faculties: string[]
  specialties: string[]
  courses: string[]
  groupIds: number[]
}

export interface OptionInput { id?: number; text: string }
export interface QuestionInput {
  id?: number
  type: QuestionType
  text: string
  required: boolean
  scaleMax: number | null
  allowOther: boolean
  options: OptionInput[]
}

export interface SurveyInput {
  title: string
  description: string | null
  surveyType: string
  isAnonymous: boolean
  isActive: boolean
  startAt: Date
  endAt: Date
  estimatedMinutes: number | null
  reminderIntervalDays: number
  targets: TargetRule[]
  questions: QuestionInput[]
}

/** So'rovnomani boshqaruvchi: admin (hammasi) yoki dekan (o'z fakultetlari) */
export interface SurveyManager {
  hemisId: string
  name: string
  role: "admin" | "dean"
  /** Dekanga biriktirilgan fakultetlar; admin uchun null (cheklovsiz) */
  faculties: string[] | null
}

/** So'rovnomani to'ldiruvchi (token egasi) */
export interface SurveyRespondent {
  role: ParticipantRole
  userId: number
  idNumbers: string[]
}

export class SurveyError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/* ── Kichik yordamchilar ────────────────────────────────────────────── */

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+$/g, "").replace(/^\s+/g, "").slice(0, max) : ""
}

function cleanStringList(v: unknown, max = 200): string[] {
  if (!Array.isArray(v)) return []
  const out = new Set<string>()
  for (const item of v) {
    const s = typeof item === "string" ? item.trim() : typeof item === "number" ? String(item) : ""
    if (s) out.add(s.slice(0, 255))
    if (out.size >= max) break
  }
  return [...out]
}

function cleanIdList(v: unknown, max = 500): number[] {
  if (!Array.isArray(v)) return []
  const out = new Set<number>()
  for (const item of v) {
    const n = Number(item)
    if (Number.isInteger(n) && n > 0) out.add(n)
    if (out.size >= max) break
  }
  return [...out]
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string" && typeof v !== "number") return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

function jsonList(v: unknown): string[] {
  if (v == null) return []
  try {
    const parsed = typeof v === "string" ? JSON.parse(v) : v
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** JSON_UNQUOTE(JSON null) "null" matnini qaytaradi — uni bo'sh deb olamiz */
function dbText(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s && s !== "null" ? s : null
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/* ── Kiritilgan ma'lumotni tekshirish (sof funksiyalar — testlanadi) ── */

export function normalizeTargets(raw: unknown): TargetRule[] {
  if (!Array.isArray(raw)) return []
  const rules: TargetRule[] = []
  for (const item of raw.slice(0, LIMITS.rules)) {
    const r = asRecord(item)
    const audience = r.audience === "teacher" ? "teacher" : r.audience === "student" ? "student" : null
    if (!audience) continue
    rules.push({
      audience,
      faculties: cleanStringList(r.faculties),
      specialties: cleanStringList(r.specialties),
      courses: cleanStringList(r.courses),
      groupIds: cleanIdList(r.groupIds),
    })
  }
  return rules
}

function normalizeQuestion(raw: unknown, index: number): QuestionInput {
  const q = asRecord(raw)
  const type = (QUESTION_TYPES as readonly string[]).includes(String(q.type)) ? (q.type as QuestionType) : null
  if (!type) throw new SurveyError(400, `${index + 1}-savol: turi noto'g'ri`)
  const text = cleanText(q.text, LIMITS.question)
  if (!text) throw new SurveyError(400, `${index + 1}-savol: matn kiritilmagan`)
  const id = Number(q.id)
  const question: QuestionInput = {
    ...(Number.isInteger(id) && id > 0 ? { id } : {}),
    type,
    text,
    required: q.required !== false,
    scaleMax: null,
    allowOther: false,
    options: [],
  }
  if (type === "single" || type === "multiple") {
    const rawOptions = Array.isArray(q.options) ? q.options : []
    const seen = new Set<string>()
    for (const o of rawOptions) {
      const rec = typeof o === "string" ? { text: o } : asRecord(o)
      const optText = cleanText(rec.text, LIMITS.option)
      if (!optText) continue
      const key = optText.toLowerCase()
      if (seen.has(key)) throw new SurveyError(400, `${index + 1}-savol: «${optText}» varianti takrorlangan`)
      seen.add(key)
      const optId = Number(rec.id)
      question.options.push({ ...(Number.isInteger(optId) && optId > 0 ? { id: optId } : {}), text: optText })
    }
    if (question.options.length < 2) throw new SurveyError(400, `${index + 1}-savol: kamida 2 ta javob varianti kerak`)
    if (question.options.length > LIMITS.options) throw new SurveyError(400, `${index + 1}-savol: variantlar ${LIMITS.options} tadan oshmasin`)
    question.allowOther = q.allowOther === true
  } else if (type === "scale") {
    question.scaleMax = Number(q.scaleMax) === 10 ? 10 : 5
  } else if (type === "rating") {
    question.scaleMax = 5
  }
  return question
}

/** So'rovnoma formasini tekshiradi. publish=true bo'lsa — e'lon uchun to'liq talablar. */
export function validateSurveyInput(body: unknown, opts: { publish: boolean; now?: Date }): SurveyInput {
  const b = asRecord(body)
  const title = cleanText(b.title, LIMITS.title)
  if (title.length < 3) throw new SurveyError(400, "So'rovnoma nomi kamida 3 belgi bo'lsin")
  const description = cleanText(b.description, LIMITS.description) || null
  const surveyType = typeof b.surveyType === "string" && SURVEY_TYPES[b.surveyType] ? b.surveyType : "umumiy"

  const startAt = parseDate(b.startAt)
  const endAt = parseDate(b.endAt)
  if (!startAt || !endAt) throw new SurveyError(400, "Boshlanish va tugash sanasini kiriting")
  if (endAt.getTime() <= startAt.getTime()) throw new SurveyError(400, "Tugash sanasi boshlanishdan keyin bo'lishi kerak")
  const now = opts.now ?? new Date()
  if (opts.publish && endAt.getTime() <= now.getTime()) throw new SurveyError(400, "Tugash sanasi o'tib ketgan — sanani o'zgartiring")

  let estimatedMinutes: number | null = null
  if (b.estimatedMinutes !== undefined && b.estimatedMinutes !== null && b.estimatedMinutes !== "") {
    const n = Math.round(Number(b.estimatedMinutes))
    if (!Number.isFinite(n) || n < 1 || n > 180) throw new SurveyError(400, "Taxminiy davomiylik 1–180 daqiqa oralig'ida bo'lsin")
    estimatedMinutes = n
  }
  const reminder = b.reminderIntervalDays === undefined ? 3 : Math.round(Number(b.reminderIntervalDays))
  if (!Number.isFinite(reminder) || reminder < 0 || reminder > 30) throw new SurveyError(400, "Eslatma oralig'i 0–30 kun bo'lsin")

  const targets = normalizeTargets(b.targets)
  const rawQuestions = Array.isArray(b.questions) ? b.questions : []
  if (rawQuestions.length > LIMITS.questions) throw new SurveyError(400, `Savollar ${LIMITS.questions} tadan oshmasin`)
  const questions = rawQuestions.map((q, i) => normalizeQuestion(q, i))

  if (opts.publish) {
    if (!targets.length) throw new SurveyError(400, "Kamida bitta auditoriya tanlang")
    if (!questions.length) throw new SurveyError(400, "Kamida bitta savol qo'shing")
  }

  return {
    title,
    description,
    surveyType,
    isAnonymous: b.isAnonymous !== false,
    isActive: b.isActive !== false,
    startAt,
    endAt,
    estimatedMinutes,
    reminderIntervalDays: reminder,
    targets,
    questions,
  }
}

/** Dekan doirasi: fakultet tanlanmagan qoidaga dekanning fakultetlari qo'yiladi,
 *  boshqa fakultet tanlangan bo'lsa — rad etiladi. Admin (scope = null) — o'zgarishsiz. */
export function applyScopeToTargets(targets: TargetRule[], scope: string[] | null): TargetRule[] {
  if (scope === null) return targets
  if (!scope.length) throw new SurveyError(403, "Sizga fakultet biriktirilmagan — admin «Dekanat fakultetlari» bo'limida biriktirishi kerak")
  const allowed = new Set(scope)
  return targets.map((rule) => {
    if (!rule.faculties.length) return { ...rule, faculties: [...scope] }
    const outside = rule.faculties.filter((f) => !allowed.has(f))
    if (outside.length) throw new SurveyError(403, `«${outside[0]}» fakulteti sizning doirangizga kirmaydi`)
    return rule
  })
}

/** Dekan bu so'rovnomani ko'ra/boshqara oladimi: o'zi yaratgan yoki doirasi
 *  butunlay o'z fakultetlari ichida bo'lgan (masalan shu fakultetning boshqa dekan xodimi). */
export function canManageSurvey(survey: { createdById: string; scopeFaculties: string[] | null }, manager: SurveyManager): boolean {
  if (manager.role === "admin") return true
  if (survey.createdById === manager.hemisId) return true
  const mine = new Set(manager.faculties ?? [])
  return !!survey.scopeFaculties?.length && survey.scopeFaculties.every((f) => mine.has(f))
}

export function surveyState(s: { status: string; isActive: boolean; archivedAt: string | null; startAt: string; endAt: string }, now = new Date()): SurveyState {
  if (s.archivedAt) return "archived"
  if (s.status !== "published") return "draft"
  if (new Date(s.endAt).getTime() <= now.getTime()) return "finished"
  if (!s.isActive) return "paused"
  if (new Date(s.startAt).getTime() > now.getTime()) return "scheduled"
  return "active"
}

/** Savollar tuzilishi o'zgarmaganmi (javoblar bor bo'lsa faqat matn/majburiylik
 *  tahrirlanadi: ID'lar, turlar, variantlar soni va shkala bir xil qolishi shart). */
export function sameQuestionStructure(existing: QuestionInput[], incoming: QuestionInput[]): boolean {
  if (existing.length !== incoming.length) return false
  return existing.every((q, i) => {
    const n = incoming[i]
    if (n.id !== q.id || n.type !== q.type || n.scaleMax !== q.scaleMax || n.allowOther !== q.allowOther) return false
    if (n.options.length !== q.options.length) return false
    return q.options.every((o, j) => n.options[j].id === o.id)
  })
}

export interface AnswerInput { optionIds?: number[]; value?: number; text?: string }
export interface AnswerRow { questionId: number; optionId: number; valueNumber: number | null; valueText: string | null }

/** Javoblarni savollarga qarab tekshiradi va bazaga yoziladigan qatorlarga aylantiradi. */
export function buildAnswerRows(questions: (Omit<QuestionInput, "id" | "options"> & { id: number; options: { id: number; text: string }[] })[], raw: unknown): AnswerRow[] {
  const answers = asRecord(raw)
  const rows: AnswerRow[] = []
  questions.forEach((q, index) => {
    const label = `${index + 1}-savol`
    const a = asRecord(answers[String(q.id)])
    const before = rows.length
    if (q.type === "single" || q.type === "multiple") {
      const valid = new Set(q.options.map((o) => o.id))
      const picked = cleanIdList(a.optionIds, LIMITS.options)
      for (const id of picked) if (!valid.has(id)) throw new SurveyError(400, `${label}: noma'lum variant`)
      const other = q.allowOther ? cleanText(a.text, LIMITS.answerText) : ""
      if (q.type === "single" && picked.length + (other ? 1 : 0) > 1) throw new SurveyError(400, `${label}: faqat bitta javob tanlanadi`)
      for (const id of picked) rows.push({ questionId: q.id, optionId: id, valueNumber: null, valueText: null })
      if (other) rows.push({ questionId: q.id, optionId: 0, valueNumber: null, valueText: other })
    } else if (q.type === "text") {
      const text = cleanText(a.text, LIMITS.answerText)
      if (text) rows.push({ questionId: q.id, optionId: 0, valueNumber: null, valueText: text })
    } else {
      const max = q.type === "yesno" ? 1 : q.scaleMax ?? 5
      const min = q.type === "yesno" ? 0 : 1
      if (a.value !== undefined && a.value !== null && a.value !== "") {
        const v = Number(a.value)
        if (!Number.isInteger(v) || v < min || v > max) throw new SurveyError(400, `${label}: qiymat ${min}–${max} oralig'ida bo'lsin`)
        rows.push({ questionId: q.id, optionId: 0, valueNumber: v, valueText: null })
      }
    }
    if (q.required && rows.length === before) throw new SurveyError(400, `${label} majburiy — javob bering`)
  })
  return rows
}

/** Anonim natijada kichik kesimlarni yashirish: n < ANON_MIN_GROUP bo'lsa null */
export function suppressSmall(count: number, anonymous: boolean): boolean {
  return anonymous && count > 0 && count < ANON_MIN_GROUP
}

/* ── Dekan fakultetlari ─────────────────────────────────────────────── */

export async function getDeanFaculties(hemisId: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT faculty_name FROM lms_dean_faculties WHERE hemis_id = ? ORDER BY faculty_name",
    [hemisId]
  )
  return rows.map((r) => String(r.faculty_name))
}

export async function setDeanFaculties(hemisId: string, faculties: string[]): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query("DELETE FROM lms_dean_faculties WHERE hemis_id = ?", [hemisId])
    if (faculties.length) {
      await conn.query("INSERT INTO lms_dean_faculties (hemis_id, faculty_name) VALUES ?", [faculties.map((f) => [hemisId, f])])
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function listDeansWithFaculties() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.hemis_id, COALESCE(NULLIF(p.full_name, ''), e.full_name, p.hemis_id) AS full_name, e.department,
            (SELECT GROUP_CONCAT(df.faculty_name ORDER BY df.faculty_name SEPARATOR '\n') FROM lms_dean_faculties df WHERE df.hemis_id = p.hemis_id) AS faculties
     FROM lms_permissions p
     LEFT JOIN hemis_employees_directory e ON e.hemis_id = CAST(p.hemis_id AS UNSIGNED) AND p.hemis_id REGEXP '^[0-9]+$'
     WHERE p.lms_role = 'dean' AND (p.hemis_role IS NULL OR p.hemis_role <> 'student')
     ORDER BY full_name`
  )
  return rows.map((r) => ({
    hemisId: String(r.hemis_id),
    fullName: String(r.full_name),
    department: dbText(r.department),
    faculties: r.faculties ? String(r.faculties).split("\n") : [],
  }))
}

/* ── Auditoriya (HEMIS katalogi) ────────────────────────────────────── */

interface StudentRow {
  userId: number
  fullName: string
  idNumber: string | null
  groupId: number | null
  groupName: string | null
  course: string | null
  faculty: string | null
  specialty: string | null
}

async function loadMasofaviyStudents(): Promise<StudentRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT hemis_id, full_name, student_id_number, group_id, group_name, level_name,
            CASE WHEN JSON_VALID(profile) THEN JSON_UNQUOTE(JSON_EXTRACT(profile, '$.department.name')) END AS faculty,
            CASE WHEN JSON_VALID(profile) THEN JSON_UNQUOTE(JSON_EXTRACT(profile, '$.specialty.name')) END AS specialty
     FROM hemis_students_directory
     WHERE is_active = 1 AND education_form_code = ? AND hemis_id < ?`,
    [MASOFAVIY_FORM, RESERVED_ID_MIN]
  )
  return rows.map((r) => ({
    userId: Number(r.hemis_id),
    fullName: String(r.full_name),
    idNumber: dbText(r.student_id_number),
    groupId: r.group_id == null ? null : Number(r.group_id),
    groupName: dbText(r.group_name),
    course: dbText(r.level_name),
    faculty: dbText(r.faculty),
    specialty: dbText(r.specialty),
  }))
}

function studentMatches(s: StudentRow, rule: TargetRule): boolean {
  if (rule.faculties.length && !rule.faculties.includes(s.faculty ?? "")) return false
  if (rule.specialties.length && !rule.specialties.includes(s.specialty ?? "")) return false
  if (rule.courses.length && !rule.courses.includes(s.course ?? "")) return false
  if (rule.groupIds.length && (s.groupId == null || !rule.groupIds.includes(s.groupId))) return false
  return true
}

export interface ParticipantRecord {
  role: ParticipantRole
  userId: number
  idNumber: string | null
  fullName: string
  faculty: string | null
  specialty: string | null
  course: string | null
  groupId: number | null
  groupName: string | null
  department: string | null
}

/** Qoidalar bo'yicha aniq odamlar ro'yxati (takrorsiz). */
export async function resolveAudience(rules: TargetRule[]): Promise<ParticipantRecord[]> {
  if (!rules.length) return []
  const students = await loadMasofaviyStudents()
  const result = new Map<string, ParticipantRecord>()

  for (const rule of rules.filter((r) => r.audience === "student")) {
    for (const s of students) {
      if (!studentMatches(s, rule)) continue
      result.set(`student:${s.userId}`, {
        role: "student", userId: s.userId, idNumber: s.idNumber, fullName: s.fullName,
        faculty: s.faculty, specialty: s.specialty, course: s.course,
        groupId: s.groupId, groupName: s.groupName, department: null,
      })
    }
  }

  const teacherRules = rules.filter((r) => r.audience === "teacher")
  if (teacherRules.length) {
    // O'qituvchi qoidasi: filtrlar talabalar guruhlarini tanlaydi — shu
    // guruhlarda dars beradigan o'qituvchilar auditoriyaga kiradi.
    const groupIds = new Set<number>()
    for (const rule of teacherRules) {
      for (const s of students) if (s.groupId != null && studentMatches(s, rule)) groupIds.add(s.groupId)
    }
    if (groupIds.size) {
      const [pairs] = await pool.query<RowDataPacket[]>(
        `SELECT DISTINCT tid FROM (
           SELECT user_id AS tid, group_id FROM lms_teacher_groups
           UNION SELECT teacher_user_id, group_id FROM lms_teacher_schedule WHERE group_id IS NOT NULL
           UNION SELECT teacher_user_id, group_id FROM lms_teacher_content WHERE is_active = 1 AND group_id IS NOT NULL
         ) x
         WHERE tid > 0 AND tid < ? AND group_id IN (?)`,
        [RESERVED_ID_MIN, [...groupIds]]
      )
      const teacherIds = pairs.map((p) => Number(p.tid))
      for (const ids of chunk(teacherIds, 1000)) {
        const [[dirRows], [loginRows]] = await Promise.all([
          pool.query<RowDataPacket[]>(
            `SELECT e.hemis_id, e.full_name, e.employee_id_number, e.department, d.name AS faculty
             FROM hemis_employees_directory e
             LEFT JOIN hemis_departments_directory d
               ON d.hemis_id = CASE WHEN JSON_VALID(e.profile)
                                    THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(e.profile, '$.department.parent')) AS UNSIGNED) END
             WHERE e.hemis_id IN (?)`,
            [ids]
          ),
          // Katalogda topilmagan (masalan yangi) xodim — LMS'ga kirganlar ro'yxatidan ism
          pool.query<RowDataPacket[]>(
            "SELECT teacher_user_id, MAX(full_name) AS full_name FROM hemis_users WHERE role = 'employee' AND teacher_user_id IN (?) AND full_name IS NOT NULL GROUP BY teacher_user_id",
            [ids]
          ),
        ])
        const dir = new Map(dirRows.map((r) => [Number(r.hemis_id), r]))
        const loginNames = new Map(loginRows.map((r) => [Number(r.teacher_user_id), dbText(r.full_name)]))
        for (const userId of ids) {
          const d = dir.get(userId)
          const name = dbText(d?.full_name) ?? loginNames.get(userId) ?? null
          if (!name) continue // katalogda ham, kirganlar ro'yxatida ham yo'q — soxta/eskirgan ID
          result.set(`employee:${userId}`, {
            role: "employee", userId, idNumber: dbText(d?.employee_id_number), fullName: name,
            faculty: dbText(d?.faculty), specialty: null, course: null,
            groupId: null, groupName: null, department: dbText(d?.department),
          })
        }
      }
    }
  }
  return [...result.values()]
}

/** Auditoriya tanlovlari uchun ro'yxatlar (dekan uchun — faqat o'z fakultetlari). */
export async function audienceOptions(scope: string[] | null) {
  const students = (await loadMasofaviyStudents()).filter((s) => scope === null || scope.includes(s.faculty ?? ""))
  const faculties = new Map<string, number>()
  const specialties = new Map<string, { faculty: string | null; count: number }>()
  const courses = new Map<string, number>()
  const groups = new Map<number, { id: number; name: string; faculty: string | null; specialty: string | null; course: string | null; count: number }>()
  for (const s of students) {
    if (s.faculty) faculties.set(s.faculty, (faculties.get(s.faculty) ?? 0) + 1)
    if (s.specialty) {
      const sp = specialties.get(s.specialty) ?? { faculty: s.faculty, count: 0 }
      sp.count += 1
      specialties.set(s.specialty, sp)
    }
    if (s.course) courses.set(s.course, (courses.get(s.course) ?? 0) + 1)
    if (s.groupId != null) {
      const g = groups.get(s.groupId) ?? { id: s.groupId, name: s.groupName ?? `#${s.groupId}`, faculty: s.faculty, specialty: s.specialty, course: s.course, count: 0 }
      g.count += 1
      groups.set(s.groupId, g)
    }
  }
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, "uz")
  return {
    faculties: [...faculties].map(([name, count]) => ({ name, count })).sort(byName),
    specialties: [...specialties].map(([name, v]) => ({ name, faculty: v.faculty, count: v.count })).sort(byName),
    courses: [...courses].map(([name, count]) => ({ name, count })).sort(byName),
    groups: [...groups.values()].sort(byName),
    totalStudents: students.length,
  }
}

/** Barcha masofaviy fakultetlar (dekanga biriktirish uchun) */
export async function allFaculties(): Promise<string[]> {
  return (await audienceOptions(null)).faculties.map((f) => f.name)
}

/* ── So'rovnoma yozuvi ──────────────────────────────────────────────── */

export interface SurveyRecord {
  id: number
  title: string
  description: string | null
  surveyType: string
  surveyTypeLabel: string
  isAnonymous: boolean
  status: "draft" | "published"
  isActive: boolean
  state: SurveyState
  startAt: string
  endAt: string
  estimatedMinutes: number | null
  reminderIntervalDays: number
  scopeFaculties: string[] | null
  createdById: string
  createdByName: string | null
  createdByRole: string
  publishedAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

function mapSurvey(r: RowDataPacket, now = new Date()): SurveyRecord {
  const base = {
    id: Number(r.id),
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    surveyType: String(r.survey_type),
    surveyTypeLabel: SURVEY_TYPES[String(r.survey_type)] ?? String(r.survey_type),
    isAnonymous: !!r.is_anonymous,
    status: r.status === "published" ? "published" as const : "draft" as const,
    isActive: !!r.is_active,
    startAt: iso(r.start_at) ?? new Date().toISOString(),
    endAt: iso(r.end_at) ?? new Date().toISOString(),
    estimatedMinutes: r.estimated_minutes == null ? null : Number(r.estimated_minutes),
    reminderIntervalDays: Number(r.reminder_interval_days ?? 3),
    scopeFaculties: r.scope_faculties == null ? null : jsonList(r.scope_faculties),
    createdById: String(r.created_by_id),
    createdByName: r.created_by_name ? String(r.created_by_name) : null,
    createdByRole: String(r.created_by_role),
    publishedAt: iso(r.published_at),
    archivedAt: iso(r.archived_at),
    createdAt: iso(r.created_at) ?? new Date().toISOString(),
    updatedAt: iso(r.updated_at) ?? new Date().toISOString(),
  }
  return { ...base, state: surveyState(base, now) }
}

async function getSurveyRow(id: number): Promise<SurveyRecord | null> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM lms_surveys WHERE id = ?", [id])
  return rows[0] ? mapSurvey(rows[0]) : null
}

/** Boshqaruvchi uchun so'rovnoma (ruxsat tekshiruvi bilan) — topilmasa/ruxsat bo'lmasa 404 */
export async function getManagedSurvey(id: number, manager: SurveyManager): Promise<SurveyRecord> {
  const survey = await getSurveyRow(id)
  if (!survey || !canManageSurvey(survey, manager)) throw new SurveyError(404, "So'rovnoma topilmadi")
  return survey
}

async function loadTargets(surveyId: number): Promise<TargetRule[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM lms_survey_targets WHERE survey_id = ? ORDER BY id", [surveyId])
  return rows.map((r) => ({
    audience: r.audience === "teacher" ? "teacher" : "student",
    faculties: jsonList(r.faculties),
    specialties: jsonList(r.specialties),
    courses: jsonList(r.courses),
    groupIds: jsonList(r.group_ids).map(Number).filter((n) => Number.isInteger(n) && n > 0),
  }))
}

type StoredOption = { id: number; text: string }
type StoredQuestion = Omit<QuestionInput, "id" | "options"> & { id: number; position: number; options: StoredOption[] }

async function loadQuestions(surveyId: number, conn: Pick<PoolConnection, "query"> = pool): Promise<StoredQuestion[]> {
  const [qRows] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM lms_survey_questions WHERE survey_id = ? ORDER BY position, id",
    [surveyId]
  )
  if (!qRows.length) return []
  const [oRows] = await conn.query<RowDataPacket[]>(
    "SELECT * FROM lms_survey_options WHERE question_id IN (?) ORDER BY position, id",
    [qRows.map((q) => q.id)]
  )
  return qRows.map((q) => ({
    id: Number(q.id),
    position: Number(q.position),
    type: q.type as QuestionType,
    text: String(q.text),
    required: !!q.is_required,
    scaleMax: q.scale_max == null ? null : Number(q.scale_max),
    allowOther: !!q.allow_other,
    options: oRows.filter((o) => Number(o.question_id) === Number(q.id)).map((o) => ({ id: Number(o.id), text: String(o.text) })),
  }))
}

async function completedCount(surveyId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM lms_survey_responses WHERE survey_id = ?", [surveyId])
  return Number(rows[0]?.n ?? 0)
}

/** Tahrirlash oynasi uchun to'liq ma'lumot */
export async function getSurveyDetail(id: number, manager: SurveyManager) {
  const survey = await getManagedSurvey(id, manager)
  const [targets, questions, responses] = await Promise.all([loadTargets(id), loadQuestions(id), completedCount(id)])
  return { ...survey, targets, questions, responseCount: responses }
}

async function writeTargets(conn: PoolConnection, surveyId: number, targets: TargetRule[]) {
  await conn.query("DELETE FROM lms_survey_targets WHERE survey_id = ?", [surveyId])
  if (!targets.length) return
  await conn.query(
    "INSERT INTO lms_survey_targets (survey_id, audience, faculties, specialties, courses, group_ids) VALUES ?",
    [targets.map((t) => [
      surveyId, t.audience,
      t.faculties.length ? JSON.stringify(t.faculties) : null,
      t.specialties.length ? JSON.stringify(t.specialties) : null,
      t.courses.length ? JSON.stringify(t.courses) : null,
      t.groupIds.length ? JSON.stringify(t.groupIds) : null,
    ])]
  )
}

async function writeQuestions(conn: PoolConnection, surveyId: number, questions: QuestionInput[]) {
  await conn.query("DELETE FROM lms_survey_questions WHERE survey_id = ?", [surveyId])
  for (const [i, q] of questions.entries()) {
    const [res] = await conn.query<ResultSetHeader>(
      "INSERT INTO lms_survey_questions (survey_id, position, type, text, is_required, scale_max, allow_other) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [surveyId, i, q.type, q.text, q.required ? 1 : 0, q.scaleMax, q.allowOther ? 1 : 0]
    )
    if (q.options.length) {
      await conn.query(
        "INSERT INTO lms_survey_options (question_id, position, text) VALUES ?",
        [q.options.map((o, j) => [res.insertId, j, o.text])]
      )
    }
  }
}

/** Javoblar bor bo'lganda: faqat matn va majburiylik yangilanadi (tuzilish o'zgarmaydi) */
async function updateQuestionTexts(conn: PoolConnection, questions: QuestionInput[]) {
  for (const [i, q] of questions.entries()) {
    await conn.query("UPDATE lms_survey_questions SET text = ?, is_required = ?, position = ? WHERE id = ?", [q.text, q.required ? 1 : 0, i, q.id])
    for (const [j, o] of q.options.entries()) {
      await conn.query("UPDATE lms_survey_options SET text = ?, position = ? WHERE id = ? AND question_id = ?", [o.text, j, o.id, q.id])
    }
  }
}

async function inTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function createSurvey(input: SurveyInput, manager: SurveyManager): Promise<number> {
  const targets = applyScopeToTargets(input.targets, manager.faculties)
  return inTransaction(async (conn) => {
    const [res] = await conn.query<ResultSetHeader>(
      `INSERT INTO lms_surveys
         (title, description, survey_type, is_anonymous, status, is_active, start_at, end_at, estimated_minutes,
          reminder_interval_days, scope_faculties, created_by_id, created_by_name, created_by_role)
       VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.title, input.description, input.surveyType, input.isAnonymous ? 1 : 0, input.isActive ? 1 : 0,
        toMysqlDate(input.startAt), toMysqlDate(input.endAt), input.estimatedMinutes, input.reminderIntervalDays,
        manager.faculties === null ? null : JSON.stringify(manager.faculties),
        manager.hemisId, manager.name || null, manager.role,
      ]
    )
    await writeTargets(conn, res.insertId, targets)
    await writeQuestions(conn, res.insertId, input.questions)
    return res.insertId
  })
}

export async function updateSurvey(id: number, input: SurveyInput, manager: SurveyManager): Promise<void> {
  const survey = await getManagedSurvey(id, manager)
  if (survey.state === "archived") throw new SurveyError(409, "Arxivdagi so'rovnomani tahrirlab bo'lmaydi — avval arxivdan chiqaring")
  const targets = applyScopeToTargets(input.targets, manager.role === "admin" ? survey.scopeFaculties : manager.faculties)
  const responses = await completedCount(id)
  const existing = await loadQuestions(id)
  if (responses > 0) {
    if (input.isAnonymous !== survey.isAnonymous) throw new SurveyError(409, "Javoblar kelgan — anonimlik turini o'zgartirib bo'lmaydi")
    if (!sameQuestionStructure(existing, input.questions)) {
      throw new SurveyError(409, "Javoblar kelgan — savol qo'shish, o'chirish yoki variantlarni o'zgartirib bo'lmaydi (faqat matnni tuzatish mumkin)")
    }
  }
  if (survey.status === "published") {
    if (!input.questions.length) throw new SurveyError(400, "Kamida bitta savol qo'shing")
    if (!targets.length) throw new SurveyError(400, "Kamida bitta auditoriya tanlang")
  }
  await inTransaction(async (conn) => {
    await conn.query(
      `UPDATE lms_surveys SET title = ?, description = ?, survey_type = ?, is_anonymous = ?, is_active = ?,
         start_at = ?, end_at = ?, estimated_minutes = ?, reminder_interval_days = ?
       WHERE id = ?`,
      [
        input.title, input.description, input.surveyType, input.isAnonymous ? 1 : 0, input.isActive ? 1 : 0,
        toMysqlDate(input.startAt), toMysqlDate(input.endAt), input.estimatedMinutes, input.reminderIntervalDays, id,
      ]
    )
    await writeTargets(conn, id, targets)
    if (responses > 0) await updateQuestionTexts(conn, input.questions)
    else await writeQuestions(conn, id, input.questions)
  })
  if (survey.status === "published") await syncParticipants(id)
}

export async function publishSurvey(id: number, manager: SurveyManager): Promise<{ participants: number }> {
  const survey = await getManagedSurvey(id, manager)
  if (survey.status === "published") throw new SurveyError(409, "So'rovnoma allaqachon e'lon qilingan")
  const [targets, questions] = await Promise.all([loadTargets(id), loadQuestions(id)])
  if (!questions.length) throw new SurveyError(400, "Kamida bitta savol qo'shing")
  if (!targets.length) throw new SurveyError(400, "Kamida bitta auditoriya tanlang")
  if (new Date(survey.endAt).getTime() <= Date.now()) throw new SurveyError(400, "Tugash sanasi o'tib ketgan — sanani o'zgartiring")
  const participants = await resolveAudience(targets)
  if (!participants.length) throw new SurveyError(400, "Tanlangan auditoriyada hech kim topilmadi — filtrlarni tekshiring")
  await pool.query("UPDATE lms_surveys SET status = 'published', published_at = ? WHERE id = ?", [toMysqlDate(new Date()), id])
  const count = await syncParticipants(id, participants)
  return { participants: count }
}

export async function setSurveyActive(id: number, active: boolean, manager: SurveyManager) {
  const survey = await getManagedSurvey(id, manager)
  if (survey.state === "archived") throw new SurveyError(409, "Arxivdagi so'rovnoma")
  await pool.query("UPDATE lms_surveys SET is_active = ? WHERE id = ?", [active ? 1 : 0, id])
}

export async function setSurveyArchived(id: number, archived: boolean, manager: SurveyManager) {
  await getManagedSurvey(id, manager)
  await pool.query(
    archived ? "UPDATE lms_surveys SET archived_at = ?, is_active = 0 WHERE id = ?" : "UPDATE lms_surveys SET archived_at = NULL WHERE id = ?",
    archived ? [toMysqlDate(new Date()), id] : [id]
  )
  // Arxivlangan so'rovnoma eslatmasi qo'ng'iroqchada o'qilmagan bo'lib turmasin
  if (archived) await pool.query("UPDATE lms_notifications SET is_read = 1 WHERE dedupe_key = ? AND is_read = 0", [`survey:${id}`])
}

export async function deleteSurvey(id: number, manager: SurveyManager, force: boolean) {
  await getManagedSurvey(id, manager)
  const responses = await completedCount(id)
  if (responses > 0 && !(force && manager.role === "admin")) {
    throw new SurveyError(409, `Bu so'rovnomaga ${responses} ta javob kelgan — o'chirish o'rniga arxivlang`)
  }
  await pool.query("DELETE FROM lms_notifications WHERE dedupe_key = ?", [`survey:${id}`])
  await pool.query("DELETE FROM lms_surveys WHERE id = ?", [id])
}

export async function duplicateSurvey(id: number, manager: SurveyManager): Promise<number> {
  const detail = await getSurveyDetail(id, manager)
  const now = new Date()
  const length = Math.max(new Date(detail.endAt).getTime() - new Date(detail.startAt).getTime(), 86_400_000)
  return createSurvey({
    title: `${detail.title} (nusxa)`.slice(0, LIMITS.title),
    description: detail.description,
    surveyType: detail.surveyType,
    isAnonymous: detail.isAnonymous,
    isActive: true,
    startAt: now,
    endAt: new Date(now.getTime() + length),
    estimatedMinutes: detail.estimatedMinutes,
    reminderIntervalDays: detail.reminderIntervalDays,
    targets: detail.targets,
    questions: detail.questions.map((q) => ({ ...q, id: undefined, options: q.options.map((o) => ({ text: o.text })) })),
  }, manager.role === "admin" ? { ...manager, faculties: detail.scopeFaculties } : manager)
}

/** Boshqaruv ro'yxati: holat, auditoriya hajmi va ishtirok bilan */
export async function listManagedSurveys(manager: SurveyManager) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.*,
       (SELECT COUNT(*) FROM lms_survey_participations p WHERE p.survey_id = s.id) AS target_total,
       (SELECT COUNT(*) FROM lms_survey_participations p WHERE p.survey_id = s.id AND p.status = 'completed') AS completed_total,
       (SELECT COUNT(*) FROM lms_survey_questions q WHERE q.survey_id = s.id) AS question_count,
       (SELECT GROUP_CONCAT(DISTINCT t.audience) FROM lms_survey_targets t WHERE t.survey_id = s.id) AS audiences
     FROM lms_surveys s
     ORDER BY s.created_at DESC
     LIMIT 1000`
  )
  const now = new Date()
  return rows
    .map((r) => ({
      ...mapSurvey(r, now),
      targetTotal: Number(r.target_total ?? 0),
      completedTotal: Number(r.completed_total ?? 0),
      questionCount: Number(r.question_count ?? 0),
      audiences: r.audiences ? String(r.audiences).split(",") : [],
    }))
    .filter((s) => canManageSurvey(s, manager))
}

/* ── Ishtirokchilar ro'yxati (snapshot) ─────────────────────────────── */

/** Auditoriyani qayta yig'adi: yangilar qo'shiladi, qoidaga endi tushmaydigan
 *  va hali javob bermaganlar chiqariladi. Javob berganlar hech qachon o'chmaydi. */
export async function syncParticipants(surveyId: number, resolved?: ParticipantRecord[]): Promise<number> {
  const participants = resolved ?? (await resolveAudience(await loadTargets(surveyId)))
  const [existing] = await pool.query<RowDataPacket[]>(
    "SELECT id, user_role, user_id, status FROM lms_survey_participations WHERE survey_id = ?",
    [surveyId]
  )
  const wanted = new Set(participants.map((p) => `${p.role}:${p.userId}`))
  const have = new Set(existing.map((r) => `${r.user_role}:${r.user_id}`))
  const toAdd = participants.filter((p) => !have.has(`${p.role}:${p.userId}`))
  const toRemove = existing.filter((r) => r.status === "pending" && !wanted.has(`${r.user_role}:${r.user_id}`)).map((r) => Number(r.id))

  for (const part of chunk(toAdd, 500)) {
    await pool.query(
      `INSERT IGNORE INTO lms_survey_participations
         (survey_id, user_role, user_id, id_number, full_name, faculty, specialty, course, group_id, group_name, department)
       VALUES ?`,
      [part.map((p) => [surveyId, p.role, p.userId, p.idNumber, p.fullName.slice(0, 255), p.faculty, p.specialty, p.course, p.groupId, p.groupName, p.department])]
    )
  }
  for (const ids of chunk(toRemove, 1000)) {
    await pool.query("DELETE FROM lms_survey_participations WHERE id IN (?)", [ids])
  }
  await pool.query("UPDATE lms_surveys SET audience_synced_at = ? WHERE id = ?", [toMysqlDate(new Date()), surveyId])
  const [count] = await pool.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM lms_survey_participations WHERE survey_id = ?", [surveyId])
  return Number(count[0]?.n ?? 0)
}

export async function previewAudience(rules: TargetRule[], scope: string[] | null) {
  const participants = await resolveAudience(applyScopeToTargets(rules, scope))
  return {
    total: participants.length,
    students: participants.filter((p) => p.role === "student").length,
    teachers: participants.filter((p) => p.role === "employee").length,
  }
}

/* ── Talaba / o'qituvchi tomoni ─────────────────────────────────────── */

function participantWhere(user: SurveyRespondent): { sql: string; params: unknown[] } {
  const ids = user.idNumbers.filter(Boolean)
  if (!ids.length) return { sql: "(p.user_role = ? AND p.user_id = ?)", params: [user.role, user.userId] }
  return {
    sql: "(p.user_role = ? AND (p.user_id = ? OR p.id_number IN (?)))",
    params: [user.role, user.userId, ids],
  }
}

/** Foydalanuvchining so'rovnomalari: ochiqlari va oxirgi 90 kunda yopilganlari */
export async function listMySurveys(user: SurveyRespondent) {
  const where = participantWhere(user)
  const now = new Date()
  const since = new Date(now.getTime() - 90 * 86_400_000)
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT s.*, p.status AS my_status, p.completed_at AS my_completed_at,
       (SELECT COUNT(*) FROM lms_survey_questions q WHERE q.survey_id = s.id) AS question_count
     FROM lms_survey_participations p
     JOIN lms_surveys s ON s.id = p.survey_id
     WHERE ${where.sql} AND s.status = 'published' AND s.start_at <= ? AND s.end_at >= ?
     ORDER BY s.end_at ASC`,
    [...where.params, toMysqlDate(now), toMysqlDate(since)]
  )
  const seen = new Set<number>()
  const items = []
  for (const r of rows) {
    if (seen.has(Number(r.id))) continue
    seen.add(Number(r.id))
    const s = mapSurvey(r, now)
    const completed = r.my_status === "completed"
    // Arxivlangan va hali to'ldirilmagan — ro'yxatdan chiqadi
    if (s.state === "archived" && !completed) continue
    items.push({
      id: s.id,
      title: s.title,
      description: s.description,
      surveyTypeLabel: s.surveyTypeLabel,
      isAnonymous: s.isAnonymous,
      startAt: s.startAt,
      endAt: s.endAt,
      estimatedMinutes: s.estimatedMinutes ?? Math.max(1, Math.ceil(Number(r.question_count ?? 0) * 0.5)),
      questionCount: Number(r.question_count ?? 0),
      state: s.state,
      myStatus: completed ? "completed" as const : "pending" as const,
      completedAt: iso(r.my_completed_at),
    })
  }
  return items
}

async function findParticipation(conn: Pick<PoolConnection, "query">, surveyId: number, user: SurveyRespondent, lock = false) {
  const where = participantWhere(user)
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT p.* FROM lms_survey_participations p WHERE p.survey_id = ? AND ${where.sql}
     ORDER BY (p.user_id = ?) DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
    [surveyId, ...where.params, user.userId]
  )
  return rows[0] ?? null
}

/** To'ldirish sahifasi uchun: savollar (javoblarsiz) va o'z holati */
export async function getSurveyForRespondent(id: number, user: SurveyRespondent) {
  const participation = await findParticipation(pool, id, user)
  const survey = await getSurveyRow(id)
  if (!participation || !survey || survey.status !== "published") throw new SurveyError(404, "So'rovnoma topilmadi yoki sizga mo'ljallanmagan")
  if (survey.state === "scheduled") throw new SurveyError(403, "So'rovnoma hali boshlanmagan")
  const completed = participation.status === "completed"
  if (!completed && survey.state === "active" && !participation.opened_at) {
    await pool.query("UPDATE lms_survey_participations SET opened_at = ? WHERE id = ?", [toMysqlDate(new Date()), participation.id])
  }
  const questions = await loadQuestions(id)
  return {
    id: survey.id,
    title: survey.title,
    description: survey.description,
    surveyTypeLabel: survey.surveyTypeLabel,
    isAnonymous: survey.isAnonymous,
    startAt: survey.startAt,
    endAt: survey.endAt,
    estimatedMinutes: survey.estimatedMinutes ?? Math.max(1, Math.ceil(questions.length * 0.5)),
    state: survey.state,
    myStatus: completed ? "completed" as const : "pending" as const,
    completedAt: iso(participation.completed_at),
    questions: questions.map((q) => ({
      id: q.id, type: q.type, text: q.text, required: q.required,
      scaleMax: q.scaleMax, allowOther: q.allowOther, options: q.options,
    })),
  }
}

/** Javobni qabul qiladi. Takroriy topshirish backend darajasida bloklanadi:
 *  ishtirok qatori FOR UPDATE bilan qulflanadi, holati 'completed' bo'lsa — 409. */
export async function submitSurveyResponse(id: number, user: SurveyRespondent, rawAnswers: unknown) {
  const survey = await getSurveyRow(id)
  if (!survey || survey.status !== "published") throw new SurveyError(404, "So'rovnoma topilmadi")
  if (survey.state !== "active") {
    throw new SurveyError(409, survey.state === "scheduled" ? "So'rovnoma hali boshlanmagan" : "So'rovnoma yopilgan — javob qabul qilinmaydi")
  }
  // Avval ishtirok holati (aniq xabar uchun): begona — 403, allaqachon javob bergan — 409.
  // Asosiy himoya pastda — tranzaksiya ichida qatorni qulflab qayta tekshiriladi.
  const existing = await findParticipation(pool, id, user)
  if (!existing) throw new SurveyError(403, "Bu so'rovnoma sizga mo'ljallanmagan")
  if (existing.status === "completed") throw new SurveyError(409, "Siz bu so'rovnomaga allaqachon javob bergansiz")

  const questions = await loadQuestions(id)
  const answerRows = buildAnswerRows(questions, rawAnswers)

  const ownerUserId = await inTransaction(async (conn) => {
    const p = await findParticipation(conn, id, user, true)
    if (!p) throw new SurveyError(403, "Bu so'rovnoma sizga mo'ljallanmagan")
    if (p.status === "completed") throw new SurveyError(409, "Siz bu so'rovnomaga allaqachon javob bergansiz")
    const responseId = randomUUID()
    const anonymous = survey.isAnonymous
    await conn.query(
      `INSERT INTO lms_survey_responses
         (id, survey_id, respondent_role, user_id, full_name, faculty, specialty, course, group_name, department, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      anonymous
        // Anonim: shaxsni aniqlovchi hech narsa (ID, ism, guruh, vaqt) yozilmaydi
        ? [responseId, id, p.user_role, null, null, p.faculty, null, p.course, null, null, null]
        : [responseId, id, p.user_role, p.user_id, p.full_name, p.faculty, p.specialty, p.course, p.group_name, p.department, toMysqlDate(new Date())]
    )
    if (answerRows.length) {
      await conn.query(
        "INSERT INTO lms_survey_answers (response_id, question_id, option_id, value_number, value_text) VALUES ?",
        [answerRows.map((a) => [responseId, a.questionId, a.optionId, a.valueNumber, a.valueText])]
      )
    }
    await conn.query(
      "UPDATE lms_survey_participations SET status = 'completed', completed_at = ?, opened_at = COALESCE(opened_at, ?) WHERE id = ?",
      [toMysqlDate(new Date()), toMysqlDate(new Date()), p.id]
    )
    return Number(p.user_id)
  })
  // Javob berildi — shu so'rovnoma eslatmasi qo'ng'iroqchada o'qilgan bo'ladi
  await pool.query(
    "UPDATE lms_notifications SET is_read = 1 WHERE user_role = ? AND user_id IN (?) AND dedupe_key = ?",
    [user.role, [...new Set([ownerUserId, user.userId])], `survey:${id}`]
  ).catch(() => {})
}

/** Yon menyu nishoni uchun: ochiq va javob berilmagan so'rovnomalar soni */
export async function pendingCount(user: SurveyRespondent): Promise<number> {
  const where = participantWhere(user)
  const now = toMysqlDate(new Date())
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(DISTINCT s.id) AS n
     FROM lms_survey_participations p JOIN lms_surveys s ON s.id = p.survey_id
     WHERE ${where.sql} AND p.status = 'pending' AND s.status = 'published' AND s.is_active = 1
       AND s.archived_at IS NULL AND s.start_at <= ? AND s.end_at > ?`,
    [...where.params, now, now]
  )
  return Number(rows[0]?.n ?? 0)
}

/* ── Natijalar va tahlil ────────────────────────────────────────────── */

export interface ResultSegment { role?: string; faculty?: string; specialty?: string; course?: string; group?: string }

const SEGMENT_FIELDS = ["faculty", "specialty", "course", "group_name", "department"] as const

function segmentFilter(seg: ResultSegment, anonymous: boolean): { sql: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (seg.role === "student" || seg.role === "employee") { parts.push("r.respondent_role = ?"); params.push(seg.role) }
  if (seg.faculty) { parts.push("r.faculty = ?"); params.push(seg.faculty) }
  if (seg.course) { parts.push("r.course = ?"); params.push(seg.course) }
  // Anonim javoblarda yo'nalish va guruh saqlanmaydi
  if (!anonymous && seg.specialty) { parts.push("r.specialty = ?"); params.push(seg.specialty) }
  if (!anonymous && seg.group) { parts.push("r.group_name = ?"); params.push(seg.group) }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", params }
}

export async function getSurveyResults(id: number, manager: SurveyManager, segment: ResultSegment = {}) {
  const survey = await getManagedSurvey(id, manager)
  const questions = await loadQuestions(id)

  // 1) Ishtirok (kim javob berdi) — ishtirokchilar jadvalidan
  const [[totals], [byRole], [trend]] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total, SUM(status = 'completed') AS completed, SUM(opened_at IS NOT NULL AND status = 'pending') AS opened
       FROM lms_survey_participations WHERE survey_id = ?`, [id]),
    pool.query<RowDataPacket[]>(
      `SELECT user_role AS k, COUNT(*) AS total, SUM(status = 'completed') AS completed
       FROM lms_survey_participations WHERE survey_id = ? GROUP BY user_role`, [id]),
    pool.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(completed_at, '%Y-%m-%d') AS d, COUNT(*) AS n
       FROM lms_survey_participations WHERE survey_id = ? AND completed_at IS NOT NULL
       GROUP BY d ORDER BY d`, [id]),
  ])
  const breakdown: Record<string, { key: string; total: number; completed: number }[]> = {}
  for (const field of SEGMENT_FIELDS) {
    // Kafedra — o'qituvchilar kesimi, qolganlari — talabalar (o'qituvchining
    // kafedra fakulteti talabalar fakulteti ro'yxatiga aralashmasin)
    const role = field === "department" ? "employee" : "student"
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${field} AS k, COUNT(*) AS total, SUM(status = 'completed') AS completed
       FROM lms_survey_participations WHERE survey_id = ? AND user_role = ? AND ${field} IS NOT NULL
       GROUP BY ${field} ORDER BY ${field}`, [id, role]
    )
    breakdown[field] = rows.map((r) => ({ key: String(r.k), total: Number(r.total), completed: Number(r.completed ?? 0) }))
  }

  // 2) Javoblar tahlili (tanlangan kesim bo'yicha)
  const filter = segmentFilter(segment, survey.isAnonymous)
  const [respCount] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM lms_survey_responses r WHERE r.survey_id = ?${filter.sql}`,
    [id, ...filter.params]
  )
  const responseTotal = Number(respCount[0]?.n ?? 0)
  const suppressed = filter.sql !== "" && suppressSmall(responseTotal, survey.isAnonymous)

  const questionResults = []
  if (!suppressed && questions.length) {
    const [answerRows] = await pool.query<RowDataPacket[]>(
      `SELECT a.question_id, a.option_id, a.value_number, a.value_text
       FROM lms_survey_answers a JOIN lms_survey_responses r ON r.id = a.response_id
       WHERE r.survey_id = ?${filter.sql}
       ORDER BY a.response_id`,
      [id, ...filter.params]
    )
    const [answeredRows] = await pool.query<RowDataPacket[]>(
      `SELECT a.question_id, COUNT(DISTINCT a.response_id) AS n
       FROM lms_survey_answers a JOIN lms_survey_responses r ON r.id = a.response_id
       WHERE r.survey_id = ?${filter.sql}
       GROUP BY a.question_id`,
      [id, ...filter.params]
    )
    const answered = new Map(answeredRows.map((r) => [Number(r.question_id), Number(r.n)]))
    for (const q of questions) {
      const rows = answerRows.filter((a) => Number(a.question_id) === q.id)
      const n = answered.get(q.id) ?? 0
      const base = { id: q.id, type: q.type, text: q.text, required: q.required, answered: n, skipped: Math.max(0, responseTotal - n) }
      if (q.type === "single" || q.type === "multiple") {
        const counts = new Map<number, number>()
        for (const a of rows) if (Number(a.option_id) > 0) counts.set(Number(a.option_id), (counts.get(Number(a.option_id)) ?? 0) + 1)
        const others = rows.filter((a) => Number(a.option_id) === 0 && a.value_text).map((a) => String(a.value_text))
        questionResults.push({
          ...base,
          options: q.options.map((o) => ({ id: o.id, text: o.text, count: counts.get(o.id) ?? 0, percent: n ? Math.round(((counts.get(o.id) ?? 0) / n) * 1000) / 10 : 0 })),
          otherCount: others.length,
          otherTexts: others.slice(0, 300),
        })
      } else if (q.type === "text") {
        const texts = rows.map((a) => String(a.value_text ?? "")).filter(Boolean)
        questionResults.push({ ...base, texts: texts.slice(0, 500), textTotal: texts.length })
      } else {
        const max = q.type === "yesno" ? 1 : q.scaleMax ?? 5
        const min = q.type === "yesno" ? 0 : 1
        const dist: { value: number; count: number; percent: number }[] = []
        let sum = 0
        for (let v = min; v <= max; v += 1) {
          const c = rows.filter((a) => Number(a.value_number) === v).length
          sum += c * v
          dist.push({ value: v, count: c, percent: n ? Math.round((c / n) * 1000) / 10 : 0 })
        }
        questionResults.push({ ...base, scaleMax: max, distribution: dist, average: n && q.type !== "yesno" ? Math.round((sum / n) * 100) / 100 : null })
      }
    }
  }

  // Anonim so'rovnomada javoblar kesimi tanlovi — faqat yetarli javobli fakultet/kurslar
  const [segRows] = await pool.query<RowDataPacket[]>(
    `SELECT respondent_role, faculty, specialty, course, group_name FROM lms_survey_responses WHERE survey_id = ?`,
    [id]
  )
  const segmentChoices = (field: "faculty" | "specialty" | "course" | "group_name") => {
    if (survey.isAnonymous && (field === "specialty" || field === "group_name")) return []
    const counts = new Map<string, number>()
    for (const r of segRows) {
      const v = dbText(r[field])
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    return [...counts].filter(([, c]) => !survey.isAnonymous || c >= ANON_MIN_GROUP).map(([k, c]) => ({ key: k, responses: c })).sort((a, b) => a.key.localeCompare(b.key, "uz"))
  }

  const total = Number(totals[0]?.total ?? 0)
  const completed = Number(totals[0]?.completed ?? 0)
  return {
    survey: { ...survey, questionCount: questions.length },
    participation: {
      total,
      completed,
      pending: total - completed,
      openedNotCompleted: Number(totals[0]?.opened ?? 0),
      rate: total ? Math.round((completed / total) * 1000) / 10 : 0,
      byRole: byRole.map((r) => ({ key: String(r.k), total: Number(r.total), completed: Number(r.completed ?? 0) })),
      byFaculty: breakdown.faculty,
      bySpecialty: breakdown.specialty,
      byCourse: breakdown.course,
      byGroup: breakdown.group_name,
      byDepartment: breakdown.department,
      trend: trend.map((r) => ({ date: String(r.d), count: Number(r.n) })),
    },
    answers: {
      responseTotal,
      suppressed,
      minGroup: ANON_MIN_GROUP,
      segment,
      segmentChoices: {
        faculty: segmentChoices("faculty"),
        specialty: segmentChoices("specialty"),
        course: segmentChoices("course"),
        group: segmentChoices("group_name"),
      },
      questions: questionResults,
    },
  }
}

/** Ishtirokchilar ro'yxati (kim javob berdi / bermadi) — sahifalash bilan */
export async function listParticipants(id: number, manager: SurveyManager, q: {
  status?: string; search?: string; faculty?: string; course?: string; group?: string; role?: string; limit: number; offset: number
}) {
  await getManagedSurvey(id, manager)
  const where: string[] = ["survey_id = ?"]
  const params: unknown[] = [id]
  if (q.status === "pending" || q.status === "completed") { where.push("status = ?"); params.push(q.status) }
  if (q.role === "student" || q.role === "employee") { where.push("user_role = ?"); params.push(q.role) }
  if (q.faculty) { where.push("faculty = ?"); params.push(q.faculty) }
  if (q.course) { where.push("course = ?"); params.push(q.course) }
  if (q.group) { where.push("(group_name = ? OR department = ?)"); params.push(q.group, q.group) }
  if (q.search) { where.push("(full_name LIKE ? OR id_number LIKE ?)"); params.push(`%${q.search}%`, `%${q.search}%`) }
  const sqlWhere = where.join(" AND ")
  const [[rows], [count]] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT user_role, user_id, id_number, full_name, faculty, specialty, course, group_name, department, status, opened_at, completed_at
       FROM lms_survey_participations WHERE ${sqlWhere}
       ORDER BY status = 'completed', full_name
       LIMIT ? OFFSET ?`,
      [...params, q.limit, q.offset]
    ),
    pool.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM lms_survey_participations WHERE ${sqlWhere}`, params),
  ])
  return {
    total: Number(count[0]?.n ?? 0),
    items: rows.map((r) => ({
      role: String(r.user_role),
      userId: Number(r.user_id),
      idNumber: dbText(r.id_number),
      fullName: String(r.full_name),
      faculty: dbText(r.faculty),
      specialty: dbText(r.specialty),
      course: dbText(r.course),
      groupName: dbText(r.group_name),
      department: dbText(r.department),
      status: String(r.status),
      openedAt: iso(r.opened_at),
      completedAt: iso(r.completed_at),
    })),
  }
}

/** Excel/PDF uchun to'liq ma'lumot: savollar, har bir javob qatori, ishtirokchilar.
 *  Anonim so'rovnomada: javob qatorlarida ism yo'q, 5 tadan kam javobli
 *  rol+fakultet+kurs katagi "—" bilan yashiriladi; javob tartibi tasodifiy (UUID). */
export async function exportSurvey(id: number, manager: SurveyManager) {
  const survey = await getManagedSurvey(id, manager)
  const questions = await loadQuestions(id)
  const [responses] = await pool.query<RowDataPacket[]>(
    `SELECT id, respondent_role, full_name, faculty, specialty, course, group_name, department, submitted_at
     FROM lms_survey_responses WHERE survey_id = ? ORDER BY ${survey.isAnonymous ? "id" : "submitted_at, id"}`,
    [id]
  )
  const [answers] = await pool.query<RowDataPacket[]>(
    `SELECT a.response_id, a.question_id, a.option_id, a.value_number, a.value_text
     FROM lms_survey_answers a JOIN lms_survey_responses r ON r.id = a.response_id
     WHERE r.survey_id = ?`,
    [id]
  )
  const [participants] = await pool.query<RowDataPacket[]>(
    `SELECT user_role, id_number, full_name, faculty, specialty, course, group_name, department, status, completed_at
     FROM lms_survey_participations WHERE survey_id = ? ORDER BY user_role DESC, faculty, group_name, full_name`,
    [id]
  )

  const optionText = new Map<number, string>()
  for (const q of questions) for (const o of q.options) optionText.set(o.id, o.text)
  const byResponse = new Map<string, RowDataPacket[]>()
  for (const a of answers) {
    const list = byResponse.get(String(a.response_id)) ?? []
    list.push(a)
    byResponse.set(String(a.response_id), list)
  }
  const cellCounts = new Map<string, number>()
  const cellKey = (r: RowDataPacket) => `${r.respondent_role}|${r.faculty ?? ""}|${r.course ?? ""}`
  for (const r of responses) cellCounts.set(cellKey(r), (cellCounts.get(cellKey(r)) ?? 0) + 1)

  const rows = responses.map((r, index) => {
    const list = byResponse.get(String(r.id)) ?? []
    const hide = survey.isAnonymous && (cellCounts.get(cellKey(r)) ?? 0) < ANON_MIN_GROUP
    const cells: Record<string, string | number> = {}
    for (const q of questions) {
      const mine = list.filter((a) => Number(a.question_id) === q.id)
      if (q.type === "single" || q.type === "multiple") {
        cells[String(q.id)] = mine.map((a) => (Number(a.option_id) > 0 ? optionText.get(Number(a.option_id)) ?? "" : `Boshqa: ${a.value_text ?? ""}`)).join("; ")
      } else if (q.type === "text") {
        cells[String(q.id)] = mine.map((a) => String(a.value_text ?? "")).join("")
      } else if (q.type === "yesno") {
        cells[String(q.id)] = mine.length ? (Number(mine[0].value_number) === 1 ? "Ha" : "Yo'q") : ""
      } else {
        cells[String(q.id)] = mine.length ? Number(mine[0].value_number) : ""
      }
    }
    return {
      index: index + 1,
      role: String(r.respondent_role),
      fullName: survey.isAnonymous ? null : dbText(r.full_name),
      faculty: hide ? null : dbText(r.faculty),
      course: hide ? null : dbText(r.course),
      specialty: survey.isAnonymous ? null : dbText(r.specialty),
      groupName: survey.isAnonymous ? null : dbText(r.group_name),
      department: survey.isAnonymous ? null : dbText(r.department),
      submittedAt: survey.isAnonymous ? null : iso(r.submitted_at),
      answers: cells,
    }
  })

  return {
    survey,
    questions: questions.map((q) => ({ id: q.id, type: q.type, text: q.text, scaleMax: q.scaleMax, options: q.options })),
    responses: rows,
    participants: participants.map((p) => ({
      role: String(p.user_role),
      idNumber: dbText(p.id_number),
      fullName: String(p.full_name),
      faculty: dbText(p.faculty),
      specialty: dbText(p.specialty),
      course: dbText(p.course),
      groupName: dbText(p.group_name),
      department: dbText(p.department),
      status: String(p.status),
      completedAt: iso(p.completed_at),
    })),
  }
}

/** Admin bosh sahifasi / ro'yxat tepasi uchun umumiy raqamlar */
export function summarizeSurveys(list: { state: SurveyState; targetTotal: number; completedTotal: number }[]) {
  const live = list.filter((s) => s.state === "active")
  const target = live.reduce((a, s) => a + s.targetTotal, 0)
  const done = live.reduce((a, s) => a + s.completedTotal, 0)
  return {
    total: list.length,
    active: live.length,
    scheduled: list.filter((s) => s.state === "scheduled").length,
    drafts: list.filter((s) => s.state === "draft").length,
    archive: list.filter((s) => s.state === "finished" || s.state === "archived").length,
    activeRate: target ? Math.round((done / target) * 1000) / 10 : 0,
    activeCompleted: done,
    activeTarget: target,
  }
}

/* ── Eslatmalar (notificationScheduler har daqiqada chaqiradi) ───────── */

interface NotifyBatchItem { role: string; userId: number }

async function notifyBatch(surveyId: number, kind: string, owners: NotifyBatchItem[], text: {
  type: "system" | "reminder"; title: string; body: string; i18nKey: string; params: Record<string, string | number>
}) {
  if (!owners.length) return
  for (const part of chunk(owners, 500)) {
    // Avval log — UNIQUE kalit ikki marta yuborilishidan saqlaydi
    await pool.query(
      "INSERT IGNORE INTO lms_survey_notifications (survey_id, user_role, user_id, kind) VALUES ?",
      [part.map((o) => [surveyId, o.role, o.userId, kind])]
    )
    // Har foydalanuvchida shu so'rovnoma uchun BITTA bildirishnoma: eslatma
    // eskisining o'rniga yoziladi (yangi qator qo'shilmaydi) va yuqoriga chiqadi
    await pool.query(
      `INSERT INTO lms_notifications (user_role, user_id, type, title, body, link, i18n_key, i18n_params, dedupe_key)
       VALUES ?
       ON DUPLICATE KEY UPDATE type = VALUES(type), title = VALUES(title), body = VALUES(body),
         i18n_key = VALUES(i18n_key), i18n_params = VALUES(i18n_params), is_read = 0, created_at = CURRENT_TIMESTAMP`,
      [part.map((o) => [
        o.role, o.userId, text.type, text.title.slice(0, 255), text.body, `/sorovnomalar/${surveyId}`,
        text.i18nKey, JSON.stringify(text.params), `survey:${surveyId}`,
      ])]
    )
  }
}

function shortDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Bosqichlar: yangi so'rovnoma → har N kunda eslatma → tugashiga 24 soat qolganda
 *  oxirgi eslatma. Faqat javob bermaganlarga, har bosqich bir marta. */
export async function runSurveyNotifications(now = new Date(), onlySurveyId?: number) {
  const nowSql = toMysqlDate(now)
  const [surveys] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_surveys
     WHERE status = 'published' AND is_active = 1 AND archived_at IS NULL AND start_at <= ? AND end_at > ?
       ${onlySurveyId ? "AND id = ?" : ""}`,
    onlySurveyId ? [nowSql, nowSql, onlySurveyId] : [nowSql, nowSql]
  )
  for (const row of surveys) {
    const s = mapSurvey(row, now)
    try {
      const synced = row.audience_synced_at ? new Date(row.audience_synced_at).getTime() : 0
      if (now.getTime() - synced > AUDIENCE_RESYNC_MS) await syncParticipants(s.id)

      const start = new Date(s.startAt).getTime()
      const end = new Date(s.endAt).getTime()
      const endText = shortDate(new Date(end))
      const params = { title: s.title, date: endText }

      // 1) Yangi so'rovnoma — hali xabar olmagan, javob bermaganlarga
      const [fresh] = await pool.query<RowDataPacket[]>(
        `SELECT p.user_role, p.user_id FROM lms_survey_participations p
         WHERE p.survey_id = ? AND p.status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM lms_survey_notifications n WHERE n.survey_id = p.survey_id
                           AND n.user_role = p.user_role AND n.user_id = p.user_id AND n.kind = 'new')`,
        [s.id]
      )
      await notifyBatch(s.id, "new", fresh.map((r) => ({ role: String(r.user_role), userId: Number(r.user_id) })), {
        type: "system", title: "Yangi so'rovnoma", body: `${s.title} — ${endText} gacha`, i18nKey: "surveyNew", params,
      })

      const lastWindow = end - now.getTime() <= 24 * 3_600_000
      // 2) Davriy eslatma (oxirgi 24 soatda emas — u yerda oxirgi eslatma bor)
      if (s.reminderIntervalDays > 0 && !lastWindow) {
        const step = Math.floor((now.getTime() - start) / (s.reminderIntervalDays * 86_400_000))
        if (step >= 1) {
          const kind = `r${step}`
          const [due] = await pool.query<RowDataPacket[]>(
            `SELECT p.user_role, p.user_id FROM lms_survey_participations p
             WHERE p.survey_id = ? AND p.status = 'pending'
               AND NOT EXISTS (SELECT 1 FROM lms_survey_notifications n WHERE n.survey_id = p.survey_id
                               AND n.user_role = p.user_role AND n.user_id = p.user_id AND n.kind = ?)
               AND NOT EXISTS (SELECT 1 FROM lms_survey_notifications n WHERE n.survey_id = p.survey_id
                               AND n.user_role = p.user_role AND n.user_id = p.user_id AND n.sent_at > NOW() - INTERVAL 12 HOUR)`,
            [s.id, kind]
          )
          await notifyBatch(s.id, kind, due.map((r) => ({ role: String(r.user_role), userId: Number(r.user_id) })), {
            type: "reminder", title: "So'rovnomada qatnashishni unutmang", body: `${s.title} — ${endText} gacha`, i18nKey: "surveyReminder", params,
          })
        }
      }

      // 3) Oxirgi eslatma — tugashiga 24 soat qolganda (qisqa, 2 kundan kam so'rovnomada yuborilmaydi)
      if (lastWindow && end - start > 48 * 3_600_000) {
        const [due] = await pool.query<RowDataPacket[]>(
          `SELECT p.user_role, p.user_id FROM lms_survey_participations p
           WHERE p.survey_id = ? AND p.status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM lms_survey_notifications n WHERE n.survey_id = p.survey_id
                             AND n.user_role = p.user_role AND n.user_id = p.user_id AND n.kind = 'last')
             AND NOT EXISTS (SELECT 1 FROM lms_survey_notifications n WHERE n.survey_id = p.survey_id
                             AND n.user_role = p.user_role AND n.user_id = p.user_id AND n.sent_at > NOW() - INTERVAL 6 HOUR)`,
          [s.id]
        )
        await notifyBatch(s.id, "last", due.map((r) => ({ role: String(r.user_role), userId: Number(r.user_id) })), {
          type: "reminder", title: "So'rovnoma tugashiga 1 kun qoldi", body: `${s.title} — ${endText} gacha`, i18nKey: "surveyLast", params,
        })
      }
    } catch (err) {
      console.warn("[surveys] eslatma xatosi (#%d):", s.id, (err as { message?: string })?.message ?? err)
    }
  }
}
