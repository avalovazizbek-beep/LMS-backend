import type mysql from "mysql2/promise"
import { pool, withHemisCache } from "./db"
import { studentUserId } from "./teachingStore"
import { fetchGroupRoster } from "../routes/hemis"

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

export async function getGroupRoster(groupId: number): Promise<RosterStudent[]> {
  const { data } = await withHemisCache(
    `group-${groupId}`,
    "attendance-roster",
    () => fetchGroupRoster(groupId),
    ROSTER_CACHE_TTL_MS
  )
  return data.map((s) => ({
    studentUserId: studentUserId({ id: s.hemisId }),
    fullName: s.fullName,
    studentIdNumber: s.studentIdNumber,
  }))
}

/* ── Davomatni saqlash ──────────────────────────────────────────────── */
export interface AttendanceRecordInput {
  studentUserId: number
  fullName: string
  status: AttendanceStatus
  comment?: string | null
}

export async function saveAttendance(
  groupId: number,
  subjectName: string,
  lessonDate: string,
  records: AttendanceRecordInput[],
  markedByUserId: number
) {
  for (const r of records) {
    await pool.query(
      `INSERT INTO lms_attendance
        (group_id, subject_name, lesson_date, student_user_id, student_full_name, status, comment, marked_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         student_full_name = VALUES(student_full_name),
         status            = VALUES(status),
         comment           = VALUES(comment),
         marked_by_user_id = VALUES(marked_by_user_id)`,
      [groupId, subjectName.trim(), lessonDate, r.studentUserId, r.fullName, r.status, r.comment?.trim() || null, markedByUserId]
    )
  }
}

/* ── Bir kunlik davomat (o'qituvchi uchun roster bilan birlashtirish) ── */
export interface AttendanceRecord {
  studentUserId: number
  status: AttendanceStatus
  comment: string | null
}

export async function getAttendanceForGroupDate(
  groupId: number,
  subjectName: string,
  lessonDate: string
): Promise<Map<number, AttendanceRecord>> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT student_user_id, status, comment FROM lms_attendance WHERE group_id = ? AND subject_name = ? AND lesson_date = ?",
    [groupId, subjectName.trim(), lessonDate]
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
    `SELECT * FROM lms_attendance WHERE ${where.join(" AND ")} ORDER BY lesson_date DESC, student_full_name`,
    params
  )

  const map = new Map<string, AttendanceHistoryEntry>()
  for (const row of rows) {
    const lessonDate = toDateOnly(row.lesson_date)
    const key = `${lessonDate}__${row.subject_name}`
    if (!map.has(key)) {
      map.set(key, { lessonDate, subjectName: String(row.subject_name), records: [] })
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
    `SELECT * FROM lms_attendance WHERE ${where.join(" AND ")} ORDER BY lesson_date DESC`,
    params
  )
  return rows.map((row) => ({
    lessonDate: toDateOnly(row.lesson_date),
    subjectName: String(row.subject_name),
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

export async function recordPlatformSession(
  userId: number,
  fullName: string,
  groupId: number | null,
  role: string
): Promise<number> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role)
     VALUES (?, ?, ?, ?)`,
    [userId, fullName, groupId, role]
  )
  return result.insertId
}

export async function updateLastSeen(sessionId: number): Promise<void> {
  await pool.query(
    "UPDATE lms_platform_sessions SET last_seen_at = NOW() WHERE id = ?",
    [sessionId]
  )
}

export async function closeSession(sessionId: number): Promise<void> {
  await pool.query(
    "UPDATE lms_platform_sessions SET logout_at = NOW() WHERE id = ? AND logout_at IS NULL",
    [sessionId]
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
