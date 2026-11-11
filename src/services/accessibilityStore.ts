import type mysql from "mysql2/promise"
import { pool } from "./db"
import { SINOV_GROUP_NAME, SINOV_STUDENT_ID, SINOV_STUDENT_NAME } from "./sinovIds"

/* ── Maxsus ehtiyojli (ko'zi ojiz / zaif ko'ruvchi) talabalar ───────────
 * Admin "Talabalar ro'yxati → Maxsus ehtiyojli talabalar" bo'limida talabani
 * belgilaydi. Belgilangan talaba uchun test sahifasi ekran o'quvchi dastur
 * (NVDA, JAWS, TalkBack) bilan ishlashga moslashadi:
 *   - time_percent   — test vaqti shu foizga ko'paytiriladi (200 = 2 barobar);
 *   - skip_face      — Face ID tekshiruvi va "Yuzni sinab ko'rish" talab qilinmaydi
 *                      (ko'zi ojiz talaba yuzini kameraga to'g'rilay olmaydi);
 *   - no_tab_limit   — oynadan chiqish faqat qayd etiladi, testni yakunlamaydi
 *                      (ekran o'quvchining o'z oynalari fokusni olib qo'yadi).
 * Kalit — talabaning LMS'dagi raqamli ID'si (HEMIS id; studentUserId()). */

export interface AccessibilityStudent {
  studentUserId: number
  fullName: string
  studentIdNumber: string | null
  groupName: string | null
  timePercent: number
  skipFace: boolean
  noTabLimit: boolean
  note: string | null
  createdByName: string | null
  createdAt: string
}

/** Talabaning o'ziga (frontendga) beriladigan qisqa ko'rinish */
export interface AccessibilityProfile {
  enabled: boolean
  timePercent: number
  skipFace: boolean
  noTabLimit: boolean
}

export const NO_ACCESSIBILITY: AccessibilityProfile = { enabled: false, timePercent: 100, skipFace: false, noTabLimit: false }

export const MIN_TIME_PERCENT = 100
export const MAX_TIME_PERCENT = 400

export function clampTimePercent(value: unknown, fallback = 200): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(MAX_TIME_PERCENT, Math.max(MIN_TIME_PERCENT, n))
}

function toRow(r: mysql.RowDataPacket): AccessibilityStudent {
  return {
    studentUserId: Number(r.student_user_id),
    fullName: String(r.full_name),
    studentIdNumber: r.student_id_number ? String(r.student_id_number) : null,
    groupName: r.group_name ? String(r.group_name) : null,
    timePercent: clampTimePercent(r.time_percent),
    skipFace: Number(r.skip_face) === 1,
    noTabLimit: Number(r.no_tab_limit) === 1,
    note: r.note ? String(r.note) : null,
    createdByName: r.created_by_name ? String(r.created_by_name) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }
}

export async function listAccessibilityStudents(): Promise<AccessibilityStudent[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_accessibility_students ORDER BY full_name"
  )
  return rows.map(toRow)
}

export async function getAccessibilityStudent(studentUserId: number): Promise<AccessibilityStudent | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_accessibility_students WHERE student_user_id = ? LIMIT 1", [studentUserId]
  )
  return rows[0] ? toRow(rows[0]) : null
}

/** Test paytida har so'rovda chaqiriladi — jadval bo'lmasa ham (deploydan
    oldingi baza) testni buzmasin: xatoda "belgilanmagan" qaytadi. */
export async function getAccessibilityProfile(studentUserId: number | null | undefined): Promise<AccessibilityProfile> {
  if (!studentUserId) return NO_ACCESSIBILITY
  try {
    const row = await getAccessibilityStudent(studentUserId)
    if (!row) return NO_ACCESSIBILITY
    return { enabled: true, timePercent: row.timePercent, skipFace: row.skipFace, noTabLimit: row.noTabLimit }
  } catch {
    return NO_ACCESSIBILITY
  }
}

export interface AccessibilityInput {
  studentUserId: number
  fullName: string
  studentIdNumber: string | null
  groupName: string | null
  timePercent: number
  skipFace: boolean
  noTabLimit: boolean
  note: string | null
}

export async function saveAccessibilityStudent(
  input: AccessibilityInput, by: { id: string; name: string | null }
): Promise<AccessibilityStudent> {
  await pool.query(
    `INSERT INTO lms_accessibility_students
       (student_user_id, full_name, student_id_number, group_name, time_percent, skip_face, no_tab_limit, note, created_by_id, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       full_name = VALUES(full_name), student_id_number = VALUES(student_id_number), group_name = VALUES(group_name),
       time_percent = VALUES(time_percent), skip_face = VALUES(skip_face), no_tab_limit = VALUES(no_tab_limit), note = VALUES(note)`,
    [
      input.studentUserId, input.fullName.slice(0, 255), input.studentIdNumber, input.groupName,
      clampTimePercent(input.timePercent), input.skipFace ? 1 : 0, input.noTabLimit ? 1 : 0,
      input.note ? input.note.slice(0, 500) : null, by.id.slice(0, 64), by.name ? by.name.slice(0, 255) : null,
    ]
  )
  return (await getAccessibilityStudent(input.studentUserId))!
}

export async function removeAccessibilityStudent(studentUserId: number): Promise<boolean> {
  const [res] = await pool.query<mysql.ResultSetHeader>(
    "DELETE FROM lms_accessibility_students WHERE student_user_id = ?", [studentUserId]
  )
  return res.affectedRows > 0
}

export interface AccessibilityCandidate {
  studentUserId: number
  fullName: string
  studentIdNumber: string | null
  groupName: string | null
  marked: boolean
}

async function sinovStudentExists(): Promise<boolean> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM lms_settings WHERE key_name = 'sinov_student_password_sha256' LIMIT 1"
  )
  return rows.length > 0
}

/** HEMIS katalogidagi bitta talaba (yoki sinov talabasi) — belgilashdan oldin
    ism/guruhni klientdan emas, bazadan olish uchun */
export async function findCandidate(studentUserId: number): Promise<AccessibilityCandidate | null> {
  if (studentUserId === SINOV_STUDENT_ID) {
    if (!(await sinovStudentExists())) return null
    return { studentUserId, fullName: SINOV_STUDENT_NAME, studentIdNumber: "SINOV-0001", groupName: SINOV_GROUP_NAME, marked: false }
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT hemis_id, full_name, student_id_number, group_name FROM hemis_students_directory WHERE hemis_id = ? LIMIT 1",
    [studentUserId]
  )
  if (!rows[0]) return null
  return {
    studentUserId: Number(rows[0].hemis_id), fullName: String(rows[0].full_name),
    studentIdNumber: rows[0].student_id_number ? String(rows[0].student_id_number) : null,
    groupName: rows[0].group_name ? String(rows[0].group_name) : null, marked: false,
  }
}

/** Ism (har bir so'z alohida) yoki talaba ID raqami bo'yicha qidiruv — 20 tagacha */
export async function searchCandidates(text: string): Promise<AccessibilityCandidate[]> {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 5)
  if (!words.length || text.trim().length < 3) return []
  const esc = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const where = words.map(() => "(full_name LIKE ? OR student_id_number LIKE ?)").join(" AND ")
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT hemis_id, full_name, student_id_number, group_name FROM hemis_students_directory
     WHERE is_active = 1 AND ${where} ORDER BY full_name LIMIT 20`,
    words.flatMap((w) => [esc(w), esc(w)])
  )
  const found: AccessibilityCandidate[] = rows.map((r) => ({
    studentUserId: Number(r.hemis_id), fullName: String(r.full_name),
    studentIdNumber: r.student_id_number ? String(r.student_id_number) : null,
    groupName: r.group_name ? String(r.group_name) : null, marked: false,
  }))
  // Sinov (demo) talabasi HEMIS katalogida yo'q — yaratilgan bo'lsa qidiruvda chiqadi
  const lower = words.map((w) => w.toLowerCase())
  if (lower.every((w) => SINOV_STUDENT_NAME.toLowerCase().includes(w)) && (await sinovStudentExists())) {
    found.unshift({ studentUserId: SINOV_STUDENT_ID, fullName: SINOV_STUDENT_NAME, studentIdNumber: "SINOV-0001", groupName: SINOV_GROUP_NAME, marked: false })
  }
  if (!found.length) return found
  const [marked] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT student_user_id FROM lms_accessibility_students WHERE student_user_id IN (?)", [found.map((f) => f.studentUserId)]
  )
  const ids = new Set(marked.map((m) => Number(m.student_user_id)))
  return found.map((f) => ({ ...f, marked: ids.has(f.studentUserId) }))
}
