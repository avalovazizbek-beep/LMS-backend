import type mysql from "mysql2/promise"
import { pool } from "./db"

/* ── O'qituvchi yordamchisi (AI): kimga ko'rinadi ────────────────────────
 * Admin "Sozlamalar → Yordamchiga ruxsat" bo'limida xodimni tanlaydi.
 * Kalit — xodimning LMS'dagi raqamli ID'si (HEMIS id; teacherUserId()). */

export interface AssistantAccessRow {
  teacherUserId: number
  fullName: string
  department: string | null
  createdByName: string | null
  createdAt: string
}

export interface AssistantAccessCandidate {
  teacherUserId: number
  fullName: string
  department: string | null
  position: string | null
  granted: boolean
}

function toRow(r: mysql.RowDataPacket): AssistantAccessRow {
  return {
    teacherUserId: Number(r.teacher_user_id),
    fullName: String(r.full_name),
    department: r.department ? String(r.department) : null,
    createdByName: r.created_by_name ? String(r.created_by_name) : null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }
}

export async function listAssistantAccess(): Promise<AssistantAccessRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_assistant_access ORDER BY full_name")
  return rows.map(toRow)
}

// Har yordamchi so'rovida tekshiriladi — 30 soniya keshlanadi (admin o'zgartirsa darhol tozalanadi)
let cache: { at: number; ids: Set<number> } | null = null
const TTL_MS = 30_000

export async function hasAssistantAccess(teacherUserId: number): Promise<boolean> {
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT teacher_user_id FROM lms_assistant_access")
      cache = { at: Date.now(), ids: new Set(rows.map((r) => Number(r.teacher_user_id))) }
    }
    return cache.ids.has(teacherUserId)
  } catch {
    return false // jadval hali yo'q (deploydan oldingi baza) — ruxsat yo'q
  }
}

export async function grantAssistantAccess(
  teacherUserId: number, fullName: string, department: string | null, byName: string | null
): Promise<AssistantAccessRow> {
  await pool.query(
    `INSERT INTO lms_assistant_access (teacher_user_id, full_name, department, created_by_name)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), department = VALUES(department)`,
    [teacherUserId, fullName.slice(0, 255), department ? department.slice(0, 255) : null, byName ? byName.slice(0, 255) : null]
  )
  cache = null
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_assistant_access WHERE teacher_user_id = ?", [teacherUserId])
  return toRow(rows[0])
}

export async function revokeAssistantAccess(teacherUserId: number): Promise<boolean> {
  const [res] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_assistant_access WHERE teacher_user_id = ?", [teacherUserId])
  cache = null
  return res.affectedRows > 0
}

/** HEMIS xodimlar katalogidagi bitta xodim — ruxsat berishdan oldin ism/kafedrani bazadan olish uchun */
export async function findTeacher(teacherUserId: number): Promise<{ teacherUserId: number; fullName: string; department: string | null } | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT hemis_id, full_name, department FROM hemis_employees_directory WHERE hemis_id = ? LIMIT 1", [teacherUserId]
  )
  if (!rows[0]) return null
  return { teacherUserId: Number(rows[0].hemis_id), fullName: String(rows[0].full_name), department: rows[0].department ? String(rows[0].department) : null }
}

/** Ism (har bir so'z alohida) yoki xodim raqami/login bo'yicha qidiruv — 20 tagacha */
export async function searchTeachers(text: string): Promise<AssistantAccessCandidate[]> {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 5)
  if (!words.length || text.trim().length < 3) return []
  const esc = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const where = words.map(() => "(full_name LIKE ? OR employee_id_number LIKE ? OR login LIKE ?)").join(" AND ")
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT hemis_id, full_name, department, position FROM hemis_employees_directory
     WHERE is_active = 1 AND ${where} ORDER BY full_name LIMIT 20`,
    words.flatMap((w) => [esc(w), esc(w), esc(w)])
  )
  if (!rows.length) return []
  const [granted] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT teacher_user_id FROM lms_assistant_access WHERE teacher_user_id IN (?)", [rows.map((r) => Number(r.hemis_id))]
  )
  const ids = new Set(granted.map((g) => Number(g.teacher_user_id)))
  return rows.map((r) => ({
    teacherUserId: Number(r.hemis_id),
    fullName: String(r.full_name),
    department: r.department ? String(r.department) : null,
    position: r.position ? String(r.position) : null,
    granted: ids.has(Number(r.hemis_id)),
  }))
}
