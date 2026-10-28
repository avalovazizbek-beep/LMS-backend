import type mysql from "mysql2/promise"
import { pool, withHemisCache } from "./db"
import { studentUserId } from "./teachingStore"
import { SINOV_GROUP_ID } from "./sinovIds"
import { fetchGroupRoster, type GroupRosterStudent } from "../routes/hemis"

export { normalizeTrainingType } from "./trainingType"

export type AttendanceStatus = "present" | "absent" | "excused" | "late"

/* ── MySQL DATE ustunini "YYYY-MM-DD" ko'rinishiga o'tkazish ─────────── */
function toDateOnly(value: unknown): string {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  return String(value).slice(0, 10)
}

const ROSTER_CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6 soat

/* ── HEMIS guruh ro'yxati (kesh bilan) ─────────────────────────────── */
export interface RosterStudent {
  studentUserId: number
  fullName: string
  studentIdNumber: string | null
}

/* F.I.Sh. bo'yicha alifbo tartibi (Excel/HEMIS'dagi kabi lotin tartibida;
   O‘/G‘ dagi tutuq belgisi va katta-kichik harf farqi hisobga olinmaydi). */
const nameCollator = new Intl.Collator("en", { sensitivity: "base", ignorePunctuation: true, numeric: true })
export function sortByFullName<T extends { fullName: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => nameCollator.compare(a.fullName.trim(), b.fullName.trim()))
}

/* Fan nomini solishtirish uchun: katta-kichik harf, bo'shliqlar va turli
   tutuq belgilari (‘ ’ ʻ ` ') farqi hisobga olinmaydi */
function normalizeSubject(name: string): string {
  return name.toLowerCase().replace(/[‘’ʻʼ`´']/g, "'").replace(/\s+/g, " ").trim()
}

/** HEMIS jurnalidagi kabi faqat haqiqatan o'qiyotganlar: joriy semestrda
    birorta fan biriktirilmagan talaba (chetlashtirish jarayonida, semestrga
    o'tkazilmagan) chiqarib tashlanadi; fan nomi berilsa va HEMIS'da shu fan
    topilsa — faqat shu fanga biriktirilganlar qoladi. Fan ma'lumoti yo'q
    (eski kesh yoki HEMIS javob bermagan) bo'lsa ro'yxat o'zgarmaydi. */
function filterEnrolled(data: GroupRosterStudent[], subjectName?: string): GroupRosterStudent[] {
  if (!data.some((s) => Array.isArray(s.subjects))) return data
  let list = data.filter((s) => !Array.isArray(s.subjects) || s.subjects.length > 0)
  const wanted = subjectName ? normalizeSubject(subjectName) : ""
  if (wanted && list.some((s) => s.subjects?.some((n) => normalizeSubject(n) === wanted))) {
    list = list.filter((s) => !Array.isArray(s.subjects) || s.subjects.some((n) => normalizeSubject(n) === wanted))
  }
  return list.length ? list : data
}

async function cachedGroupRoster(groupId: number): Promise<GroupRosterStudent[]> {
  try {
    // v2 — fanlar (subjects) bilan; eski keshda ular yo'q edi, deploy'dan
    // keyin darhol yangilanishi uchun kalit almashtirildi
    return (await withHemisCache(`group-${groupId}`, "attendance-roster-v2", () => fetchGroupRoster(groupId), ROSTER_CACHE_TTL_MS)).data
  } catch (issue) {
    // HEMIS javob bermasa — eski (fansiz) kesh bo'lsa o'shani ishlatamiz
    const legacy = await withHemisCache(`group-${groupId}`, "attendance-roster", () => Promise.reject(issue), ROSTER_CACHE_TTL_MS)
    return legacy.data as GroupRosterStudent[]
  }
}

export async function getGroupRoster(groupId: number, subjectName?: string): Promise<RosterStudent[]> {
  // Sinov guruhi HEMIS'da yo'q — so'ramaymiz, ro'yxat kirgan sinov talabasidan
  const data = groupId === SINOV_GROUP_ID ? [] : filterEnrolled(await cachedGroupRoster(groupId), subjectName)
  if (data.length) {
    return sortByFullName(data.map((s) => ({
      studentUserId: studentUserId({ id: s.hemisId }),
      fullName: s.fullName,
      studentIdNumber: s.studentIdNumber,
    })))
  }
  // HEMIS has no record of this group (e.g. a locally-seeded demo group,
  // or a transient lookup miss) — fall back to whoever has actually
  // logged into the platform under it.
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT DISTINCT user_id, full_name FROM lms_platform_sessions WHERE group_id = ? AND role = 'student'`,
    [groupId]
  )
  return sortByFullName(rows.map((r) => ({
    studentUserId: Number(r.user_id),
    fullName: String(r.full_name),
    studentIdNumber: null,
  })))
}

/* ── Davomatni saqlash ──────────────────────────────────────────────── */
export interface AttendanceRecordInput {
  studentUserId: number
  fullName: string
  status: AttendanceStatus
  comment?: string | null
}

/** Server mahalliy vaqti (Asia/Tashkent) bo'yicha bugungi sana — kelajak
 *  kunlarga davomat qo'yilmasligi uchun. */
export function todayDateOnly(): string {
  return toDateOnly(new Date())
}

/** Davomat varag'i — guruh + fan + sana + mashg'ulot turi. Bir kunda ma'ruza
 *  va amaliy alohida saqlanadi va alohida qulflanadi. trainingType oldindan
 *  normalizeTrainingType'dan o'tgan bo'lishi kerak ('' — turi yo'q eski varaq).
 *
 *  O'qituvchi "Saqlash" bosgan varaq (marked_by_user_id <> 0) qulflangan
 *  hisoblanadi. Meeting'dan avtomatik (Face ID) yozilgan qatorlar
 *  (marked_by_user_id = 0) qulflamaydi — o'qituvchi ularni bir marta
 *  ko'rib chiqib, o'zi saqlaydi. */
export async function isAttendanceSheetSaved(groupId: number, subjectName: string, lessonDate: string, trainingType: string): Promise<boolean> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM lms_attendance WHERE group_id = ? AND subject_name = ? AND lesson_date = ? AND training_type = ? AND marked_by_user_id <> 0 LIMIT 1",
    [groupId, subjectName.trim(), lessonDate, trainingType]
  )
  return rows.length > 0
}

/** Shu kun uchun o'qituvchi saqlagan mashg'ulot turlari (jurnalda "bu kunda
 *  amaliy uchun ham saqlangan" deb ko'rsatish uchun). */
export async function getSavedTrainingTypes(groupId: number, subjectName: string, lessonDate: string): Promise<string[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT DISTINCT training_type FROM lms_attendance
     WHERE group_id = ? AND subject_name = ? AND lesson_date = ? AND marked_by_user_id <> 0
     ORDER BY training_type`,
    [groupId, subjectName.trim(), lessonDate]
  )
  return rows.map((r) => String(r.training_type))
}

export type SaveAttendanceResult =
  | { ok: true; usedRequestId: number | null }
  | { ok: false; reason: "locked" }

/** Davomat varag'ini (shu mashg'ulot turi uchun) saqlaydi. Varaq allaqachon
 *  saqlangan bo'lsa — faqat admin tasdiqlagan (ishlatilmagan) so'rov
 *  bo'lgandagina qayta yoziladi va o'sha so'rov "used" bo'lib qoladi, ya'ni
 *  varaq yana qulflanadi. Boshqa turdagi varaqqa (masalan shu kungi
 *  ma'ruzaga) bu ta'sir qilmaydi. */
export async function saveAttendance(
  groupId: number,
  subjectName: string,
  lessonDate: string,
  trainingType: string,
  records: AttendanceRecordInput[],
  markedByUserId: number
): Promise<SaveAttendanceResult> {
  const subject = subjectName.trim()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [savedRows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT 1 FROM lms_attendance WHERE group_id = ? AND subject_name = ? AND lesson_date = ? AND training_type = ? AND marked_by_user_id <> 0 LIMIT 1",
      [groupId, subject, lessonDate, trainingType]
    )
    let usedRequestId: number | null = null
    if (savedRows.length) {
      const [grantRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT id FROM lms_attendance_edit_requests
         WHERE group_id = ? AND subject_name = ? AND lesson_date = ? AND training_type = ? AND teacher_user_id = ? AND status = 'approved'
         ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [groupId, subject, lessonDate, trainingType, markedByUserId]
      )
      if (!grantRows.length) {
        await conn.rollback()
        return { ok: false, reason: "locked" }
      }
      usedRequestId = Number(grantRows[0].id)
    }

    for (const r of records) {
      await conn.query(
        `INSERT INTO lms_attendance
          (group_id, subject_name, lesson_date, training_type, student_user_id, student_full_name, status, comment, marked_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           student_full_name = VALUES(student_full_name),
           status            = VALUES(status),
           comment           = VALUES(comment),
           marked_by_user_id = VALUES(marked_by_user_id)`,
        [groupId, subject, lessonDate, trainingType, r.studentUserId, r.fullName, r.status, r.comment?.trim() || null, markedByUserId]
      )
    }
    // Turi noma'lum meeting'dan avtomatik (Face ID) yozilgan qatorlar jurnalda
    // shu varaqqa to'ldirib berilgan edi — o'qituvchi ko'rib chiqib saqladi,
    // endi ular ikkinchi marta sanalmasligi uchun o'chiriladi.
    if (trainingType) {
      await conn.query(
        "DELETE FROM lms_attendance WHERE group_id = ? AND subject_name = ? AND lesson_date = ? AND training_type = '' AND marked_by_user_id = 0",
        [groupId, subject, lessonDate]
      )
    }
    if (usedRequestId !== null) {
      await conn.query(
        "UPDATE lms_attendance_edit_requests SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE id = ?",
        [usedRequestId]
      )
    }
    await conn.commit()
    return { ok: true, usedRequestId }
  } catch (err) {
    await conn.rollback().catch(() => undefined)
    throw err
  } finally {
    conn.release()
  }
}

/* ── Davomatni o'zgartirish so'rovlari (o'qituvchi → admin) ──────────── */
export type AttendanceEditStatus = "pending" | "approved" | "rejected" | "used"

export interface AttendanceEditRequest {
  id: number
  groupId: number
  groupName: string | null
  subjectName: string
  lessonDate: string
  trainingType: string | null
  teacherUserId: number
  teacherName: string
  reason: string
  status: AttendanceEditStatus
  adminNote: string | null
  reviewedByName: string | null
  reviewedAt: string | null
  usedAt: string | null
  createdAt: string
}

function toIso(value: unknown): string | null {
  if (!value) return null
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function mapEditRequest(row: mysql.RowDataPacket): AttendanceEditRequest {
  return {
    id: Number(row.id),
    groupId: Number(row.group_id),
    groupName: row.group_name ? String(row.group_name) : null,
    subjectName: String(row.subject_name),
    lessonDate: toDateOnly(row.lesson_date),
    trainingType: row.training_type ? String(row.training_type) : null,
    teacherUserId: Number(row.teacher_user_id),
    teacherName: String(row.teacher_name),
    reason: String(row.reason ?? ""),
    status: row.status as AttendanceEditStatus,
    adminNote: row.admin_note ? String(row.admin_note) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewedAt: toIso(row.reviewed_at),
    usedAt: toIso(row.used_at),
    createdAt: toIso(row.created_at) ?? new Date().toISOString(),
  }
}

const EDIT_REQUEST_SELECT = `
  SELECT r.*, g.name AS group_name
  FROM lms_attendance_edit_requests r
  LEFT JOIN lms_groups g ON g.id = r.group_id`

/** O'qituvchining shu varaq uchun oxirgi so'rovi (jurnalda holatini ko'rsatish uchun). */
export async function getLatestEditRequest(
  groupId: number,
  subjectName: string,
  lessonDate: string,
  trainingType: string,
  teacherUserId: number
): Promise<AttendanceEditRequest | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `${EDIT_REQUEST_SELECT}
     WHERE r.group_id = ? AND r.subject_name = ? AND r.lesson_date = ? AND r.training_type = ? AND r.teacher_user_id = ?
     ORDER BY r.id DESC LIMIT 1`,
    [groupId, subjectName.trim(), lessonDate, trainingType, teacherUserId]
  )
  return rows[0] ? mapEditRequest(rows[0]) : null
}

export async function getEditRequest(id: number): Promise<AttendanceEditRequest | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`${EDIT_REQUEST_SELECT} WHERE r.id = ? LIMIT 1`, [id])
  return rows[0] ? mapEditRequest(rows[0]) : null
}

export async function createEditRequest(input: {
  groupId: number
  subjectName: string
  lessonDate: string
  trainingType: string
  teacherUserId: number
  teacherName: string
  reason: string
}): Promise<AttendanceEditRequest> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO lms_attendance_edit_requests
       (group_id, subject_name, lesson_date, training_type, teacher_user_id, teacher_name, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.groupId, input.subjectName.trim(), input.lessonDate, input.trainingType, input.teacherUserId, input.teacherName, input.reason]
  )
  const created = await getEditRequest(result.insertId)
  if (!created) throw new Error("So'rov saqlanmadi")
  return created
}

export async function listEditRequests(status: AttendanceEditStatus): Promise<AttendanceEditRequest[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `${EDIT_REQUEST_SELECT} WHERE r.status = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 200`,
    [status]
  )
  return rows.map(mapEditRequest)
}

export async function countPendingEditRequests(): Promise<number> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM lms_attendance_edit_requests WHERE status = 'pending'"
  )
  return Number(rows[0]?.n ?? 0)
}

/** Faqat "pending" so'rovni ko'rib chiqadi; boshqa holatda null qaytaradi. */
export async function reviewEditRequest(
  id: number,
  action: "approve" | "reject",
  note: string | null,
  reviewerName: string
): Promise<AttendanceEditRequest | null> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE lms_attendance_edit_requests
     SET status = ?, admin_note = ?, reviewed_by_name = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`,
    [action === "approve" ? "approved" : "rejected", note, reviewerName, id]
  )
  if (!result.affectedRows) return null
  return getEditRequest(id)
}

/* ── Bir kunlik davomat (o'qituvchi uchun roster bilan birlashtirish) ── */
export interface AttendanceRecord {
  studentUserId: number
  status: AttendanceStatus
  comment: string | null
}

/** Bitta varaqning yozuvlari. autoOnly — faqat meeting'dan avtomatik
 *  (Face ID) yozilgan, o'qituvchi hali saqlamagan qatorlar. */
export async function getAttendanceForGroupDate(
  groupId: number,
  subjectName: string,
  lessonDate: string,
  trainingType: string,
  autoOnly = false
): Promise<Map<number, AttendanceRecord>> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT student_user_id, status, comment FROM lms_attendance
     WHERE group_id = ? AND subject_name = ? AND lesson_date = ? AND training_type = ?${autoOnly ? " AND marked_by_user_id = 0" : ""}`,
    [groupId, subjectName.trim(), lessonDate, trainingType]
  )
  const map = new Map<number, AttendanceRecord>()
  for (const row of rows) {
    map.set(Number(row.student_user_id), {
      studentUserId: Number(row.student_user_id),
      status: row.status as AttendanceStatus,
      comment: row.comment ?? null,
    })
  }
  return map
}

/* ── O'qituvchi uchun tarix/hisobot ─────────────────────────────────── */
export interface AttendanceHistoryEntry {
  lessonDate: string
  subjectName: string
  trainingType: string | null
  records: {
    studentUserId: number
    studentFullName: string
    status: AttendanceStatus
    comment: string | null
  }[]
}

export async function getGroupAttendanceHistory(
  groupId: number,
  subjectName?: string,
  from?: string,
  to?: string
): Promise<AttendanceHistoryEntry[]> {
  const where = ["group_id = ?"]
  const params: unknown[] = [groupId]
  if (subjectName?.trim()) {
    where.push("subject_name = ?")
    params.push(subjectName.trim())
  }
  if (from) {
    where.push("lesson_date >= ?")
    params.push(from)
  }
  if (to) {
    where.push("lesson_date <= ?")
    params.push(to)
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT * FROM lms_attendance WHERE ${where.join(" AND ")} ORDER BY lesson_date DESC, training_type, student_full_name`,
    params
  )

  const map = new Map<string, AttendanceHistoryEntry>()
  for (const row of rows) {
    const lessonDate = toDateOnly(row.lesson_date)
    const key = `${lessonDate}__${row.subject_name}__${row.training_type ?? ""}`
    if (!map.has(key)) {
      map.set(key, { lessonDate, subjectName: String(row.subject_name), trainingType: row.training_type ? String(row.training_type) : null, records: [] })
    }
    map.get(key)!.records.push({
      studentUserId: Number(row.student_user_id),
      studentFullName: String(row.student_full_name),
      status: row.status as AttendanceStatus,
      comment: row.comment ?? null,
    })
  }
  return Array.from(map.values())
}

/* ── Talaba uchun o'z davomati ──────────────────────────────────────── */
export interface StudentAttendanceEntry {
  lessonDate: string
  subjectName: string
  trainingType: string | null
  status: AttendanceStatus
  comment: string | null
}

export async function getStudentAttendance(
  studentId: number,
  subjectName?: string,
  from?: string,
  to?: string
): Promise<StudentAttendanceEntry[]> {
  const where = ["student_user_id = ?"]
  const params: unknown[] = [studentId]
  if (subjectName?.trim()) {
    where.push("subject_name = ?")
    params.push(subjectName.trim())
  }
  if (from) {
    where.push("lesson_date >= ?")
    params.push(from)
  }
  if (to) {
    where.push("lesson_date <= ?")
    params.push(to)
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT * FROM lms_attendance WHERE ${where.join(" AND ")} ORDER BY lesson_date DESC, training_type`,
    params
  )
  return rows.map((row) => ({
    lessonDate: toDateOnly(row.lesson_date),
    subjectName: String(row.subject_name),
    trainingType: row.training_type ? String(row.training_type) : null,
    status: row.status as AttendanceStatus,
    comment: row.comment ?? null,
  }))
}

/* ── Guruh davomat xulosasi (jurnal uchun) ───────────────────────────── */
export async function getAttendanceSummary(
  groupId: number,
  subjectName: string
): Promise<{ studentUserId: number; present: number; total: number }[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT student_user_id,
            SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present,
            COUNT(*) AS total
     FROM lms_attendance
     WHERE group_id = ? AND LOWER(subject_name) = LOWER(?)
     GROUP BY student_user_id`,
    [groupId, subjectName]
  )
  return rows.map(r => ({
    studentUserId: Number(r.student_user_id),
    present: Number(r.present),
    total: Number(r.total),
  }))
}

/* ── Platform sessiyalari ───────────────────────────────────────────── */

export interface LoginMeta {
  ip?: string | null
  userAgent?: string | null
}

export async function recordPlatformSession(
  userId: number,
  fullName: string,
  groupId: number | null,
  role: string,
  meta?: LoginMeta
): Promise<number> {
  // Yangi kirish — chiqilmay qolgan oldingi sessiyalar oxirgi faollik vaqtida
  // yopiladi ("Hali chiqmagan" qatorlari to'planib qolmasin). Faollik signali
  // umuman kelmagan (eski) sessiyaga tegilmaydi — chiqishi kirishiga teng
  // bo'lib qolmasin. last_seen_at'ni o'ziga tenglaymiz — aks holda ON UPDATE
  // uni hozirgi vaqtga surardi.
  await pool.query(
    `UPDATE lms_platform_sessions SET logout_at = last_seen_at, last_seen_at = last_seen_at
     WHERE user_id = ? AND role = ? AND logout_at IS NULL AND last_seen_at > login_at`,
    [userId, role]
  )
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, fullName, groupId, role, meta?.ip?.slice(0, 64) || null, meta?.userAgent?.slice(0, 300) || null]
  )
  return result.insertId
}

/** Foydalanuvchining o'z kirishlari ("Kirish tarixi" sahifasi), yangisi birinchi */
export async function listUserSessions(userId: number, role: string, limit = 50) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT login_at, ip_address, user_agent FROM lms_platform_sessions
     WHERE user_id = ? AND role = ? ORDER BY login_at DESC LIMIT ?`,
    [userId, role, limit]
  )
  return rows.map(r => ({
    loginAt: new Date(r.login_at).toISOString(),
    ip: r.ip_address ? String(r.ip_address) : null,
    userAgent: r.user_agent ? String(r.user_agent) : null,
  }))
}

/* Sessiya oxiri: frontend tizimda turgan foydalanuvchi uchun har ~2 daqiqada
   "hali shu yerda" yuboradi (last_seen_at), chiqishda (tugma yoki 30 daqiqa
   harakatsizlik) — sessiyani yopadi (logout_at). Brauzer shunchaki yopilsa
   chiqish vaqti oxirgi signal (last_seen_at) bo'ladi. */

/** Foydalanuvchining eng so'nggi ochiq sessiyasi — hali tizimda */
export async function touchLatestSession(userId: number, role: string): Promise<void> {
  await pool.query(
    `UPDATE lms_platform_sessions SET last_seen_at = NOW()
     WHERE user_id = ? AND role = ? AND logout_at IS NULL
     ORDER BY login_at DESC LIMIT 1`,
    [userId, role]
  )
}

/** Chiqish: eng so'nggi ochiq sessiya yopiladi */
export async function closeLatestSession(userId: number, role: string): Promise<void> {
  await pool.query(
    `UPDATE lms_platform_sessions SET logout_at = NOW(), last_seen_at = NOW()
     WHERE user_id = ? AND role = ? AND logout_at IS NULL
     ORDER BY login_at DESC LIMIT 1`,
    [userId, role]
  )
}

export interface PlatformSessionEntry {
  sessionId: number
  userId: number
  fullName: string
  groupId: number | null
  role: string
  loginAt: string
  lastSeenAt: string
  logoutAt: string | null
  durationMinutes: number
}

export async function getGroupSessions(
  groupId: number,
  date: string
): Promise<PlatformSessionEntry[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT *,
       TIMESTAMPDIFF(MINUTE, login_at, COALESCE(logout_at, last_seen_at)) AS dur
     FROM lms_platform_sessions
     WHERE group_id = ? AND DATE(login_at) = ?
     ORDER BY login_at DESC`,
    [groupId, date]
  )
  return rows.map((r) => ({
    sessionId:       Number(r.id),
    userId:          Number(r.user_id),
    fullName:        String(r.full_name),
    groupId:         r.group_id == null ? null : Number(r.group_id),
    role:            String(r.role),
    loginAt:         r.login_at instanceof Date ? r.login_at.toISOString() : String(r.login_at),
    lastSeenAt:      r.last_seen_at instanceof Date ? r.last_seen_at.toISOString() : String(r.last_seen_at),
    logoutAt:        r.logout_at ? (r.logout_at instanceof Date ? r.logout_at.toISOString() : String(r.logout_at)) : null,
    durationMinutes: Number(r.dur ?? 0),
  }))
}

export async function getStudentSessions(
  userId: number,
  from?: string,
  to?: string
): Promise<PlatformSessionEntry[]> {
  const where = ["user_id = ?"]
  const params: unknown[] = [userId]
  if (from) { where.push("DATE(login_at) >= ?"); params.push(from) }
  if (to)   { where.push("DATE(login_at) <= ?"); params.push(to) }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT *, TIMESTAMPDIFF(MINUTE, login_at, COALESCE(logout_at, last_seen_at)) AS dur
     FROM lms_platform_sessions WHERE ${where.join(" AND ")} ORDER BY login_at DESC`,
    params
  )
  return rows.map((r) => ({
    sessionId:       Number(r.id),
    userId:          Number(r.user_id),
    fullName:        String(r.full_name),
    groupId:         r.group_id == null ? null : Number(r.group_id),
    role:            String(r.role),
    loginAt:         r.login_at instanceof Date ? r.login_at.toISOString() : String(r.login_at),
    lastSeenAt:      r.last_seen_at instanceof Date ? r.last_seen_at.toISOString() : String(r.last_seen_at),
    logoutAt:        r.logout_at ? (r.logout_at instanceof Date ? r.logout_at.toISOString() : String(r.logout_at)) : null,
    durationMinutes: Number(r.dur ?? 0),
  }))
}
