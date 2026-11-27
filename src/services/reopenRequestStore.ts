import type mysql from "mysql2/promise"
import { pool, fromMysqlDate } from "./db"

/**
 * Oraliq nazorat va mustaqil ishni qayta ochish so'rovlari (2026-11-27).
 *
 * Foydalanuvchi qoidasi:
 *  - Nazorat muddati tugagach 5 kun ichida qayta ochish mumkin. O'qituvchi
 *    talabalarni belgilab so'rov yuboradi, admin tasdiqlaydi — shundagina
 *    o'sha talabalarga bir martalik ruxsat (lms_exam_retake_grants) yoziladi.
 *    Admin o'zi to'g'ridan-to'g'ri ochmaydi.
 *  - 5 kundan keyin nazorat "qizil": endi hech kim (admin ham) ocha olmaydi,
 *    javobsiz qolgan so'rovlar "muddati o'tdi" bo'ladi.
 *  - 10 kundan keyin nazorat o'qituvchi sahifasida avtomatik "Arxiv"ga o'tadi
 *    (hech narsa o'chirilmaydi — faqat ro'yxat ajratiladi, frontendda).
 */

export const REOPEN_WINDOW_DAYS = 5
export const ARCHIVE_AFTER_DAYS = 10
const DAY_MS = 24 * 60 * 60 * 1000

export interface ReopenWindow {
  /** Nazorat muddati (null — muddatsiz, oyna doim ochiq) */
  deadline: string | null
  /** Shu paytgacha qayta ochish mumkin (muddat + 5 kun) */
  closesAt: string | null
  /** Shu paytdan keyin o'qituvchi sahifasida "Arxiv"da (muddat + 10 kun) */
  archiveAt: string | null
  /** Muddat o'tganmi */
  ended: boolean
  /** Qayta ochish mumkinmi (so'rov yuborish va tasdiqlash) */
  open: boolean
  archived: boolean
}

export function reopenWindow(deadline: string | null, now = Date.now()): ReopenWindow {
  const d = deadline ? new Date(deadline).getTime() : NaN
  if (!Number.isFinite(d)) {
    return { deadline: null, closesAt: null, archiveAt: null, ended: false, open: true, archived: false }
  }
  const closes = d + REOPEN_WINDOW_DAYS * DAY_MS
  const archive = d + ARCHIVE_AFTER_DAYS * DAY_MS
  return {
    deadline: new Date(d).toISOString(),
    closesAt: new Date(closes).toISOString(),
    archiveAt: new Date(archive).toISOString(),
    ended: now > d,
    open: now <= closes,
    archived: now > archive,
  }
}

export type ReopenStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired"
export const REOPEN_STATUSES: readonly ReopenStatus[] = ["pending", "approved", "rejected", "cancelled", "expired"]

export interface ReopenStudent {
  userId: number
  fullName: string
}

export interface ReopenRequest {
  id: number
  contentId: number
  teacherUserId: number
  teacherName: string
  students: ReopenStudent[]
  reason: string
  status: ReopenStatus
  adminNote: string | null
  reviewedByName: string | null
  reviewedAt: string | null
  grantedCount: number
  createdAt: string
  /** Nazorat haqida (ro'yxatlarda ko'rsatish uchun) */
  content: {
    title: string
    type: string
    controlType: string | null
    kind: string | null
    gradePoints: number | null
    gradePart: string | null
    subjectName: string
    groupId: number
    groupName: string
    deadline: string | null
  }
  window: ReopenWindow
}

function parseStudents(raw: unknown): ReopenStudent[] {
  try {
    const list = typeof raw === "string" ? JSON.parse(raw) : raw
    if (!Array.isArray(list)) return []
    return list
      .map((s) => ({ userId: Number(s?.userId), fullName: String(s?.fullName ?? "") }))
      .filter((s) => Number.isFinite(s.userId) && s.userId > 0)
  } catch {
    return []
  }
}

function mapRow(row: mysql.RowDataPacket): ReopenRequest {
  const deadline = row.deadline ? fromMysqlDate(row.deadline) : null
  return {
    id: Number(row.id),
    contentId: Number(row.content_id),
    teacherUserId: Number(row.teacher_user_id),
    teacherName: String(row.teacher_name ?? ""),
    students: parseStudents(row.students),
    reason: String(row.reason ?? ""),
    status: row.status as ReopenStatus,
    adminNote: row.admin_note ? String(row.admin_note) : null,
    reviewedByName: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    reviewedAt: row.reviewed_at ? fromMysqlDate(row.reviewed_at) : null,
    grantedCount: Number(row.granted_count ?? 0),
    createdAt: fromMysqlDate(row.created_at),
    content: {
      title: String(row.title ?? ""),
      type: String(row.type ?? ""),
      controlType: row.control_type ?? null,
      kind: row.kind ?? null,
      gradePoints: row.grade_points == null ? null : Number(row.grade_points),
      gradePart: row.grade_part ?? null,
      subjectName: String(row.subject_name ?? ""),
      groupId: Number(row.group_id),
      groupName: row.group_name ? String(row.group_name) : `Guruh ${row.group_id}`,
      deadline,
    },
    window: reopenWindow(deadline),
  }
}

const SELECT = `
  SELECT r.*, tc.title, tc.type, tc.control_type, tc.kind, tc.grade_points, tc.grade_part,
         tc.subject_name, tc.group_id, tc.deadline, g.name AS group_name
  FROM lms_reopen_requests r
  JOIN lms_teacher_content tc ON tc.id = r.content_id
  LEFT JOIN lms_groups g ON g.id = tc.group_id`

/** Muddati (muddat + 5 kun) o'tib ketgan javobsiz so'rovlarni "expired" qiladi.
    Ro'yxat/tasdiqlashdan oldin chaqiriladi — alohida jadval-ishchi kerak emas. */
export async function expireStaleReopenRequests(): Promise<void> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT r.id, tc.deadline FROM lms_reopen_requests r
     JOIN lms_teacher_content tc ON tc.id = r.content_id
     WHERE r.status = 'pending'`
  )
  const now = Date.now()
  const stale = rows
    .filter((r) => !reopenWindow(r.deadline ? fromMysqlDate(r.deadline) : null, now).open)
    .map((r) => Number(r.id))
  if (stale.length) {
    await pool.query("UPDATE lms_reopen_requests SET status = 'expired' WHERE status = 'pending' AND id IN (?)", [stale])
  }
}

export async function getReopenRequest(id: number): Promise<ReopenRequest | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`${SELECT} WHERE r.id = ? LIMIT 1`, [id])
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listReopenRequestsForContent(contentId: number): Promise<ReopenRequest[]> {
  await expireStaleReopenRequests()
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `${SELECT} WHERE r.content_id = ? ORDER BY r.id DESC LIMIT 50`, [contentId]
  )
  return rows.map(mapRow)
}

/** O'qituvchining so'rovlari — kartalarda holatini ko'rsatish uchun */
export async function listReopenRequestsForTeacher(teacherUserId: number): Promise<ReopenRequest[]> {
  await expireStaleReopenRequests()
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `${SELECT} WHERE r.teacher_user_id = ? ORDER BY r.id DESC LIMIT 500`, [teacherUserId]
  )
  return rows.map(mapRow)
}

export async function listReopenRequests(status: ReopenStatus | "all"): Promise<ReopenRequest[]> {
  await expireStaleReopenRequests()
  const [rows] = status === "all"
    ? await pool.query<mysql.RowDataPacket[]>(`${SELECT} ORDER BY r.id DESC LIMIT 300`)
    : await pool.query<mysql.RowDataPacket[]>(
        `${SELECT} WHERE r.status = ? ORDER BY ${status === "pending" ? "r.id ASC" : "r.id DESC"} LIMIT 300`, [status]
      )
  return rows.map(mapRow)
}

export async function countPendingReopenRequests(): Promise<number> {
  await expireStaleReopenRequests()
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM lms_reopen_requests WHERE status = 'pending'"
  )
  return Number(rows[0]?.n ?? 0)
}

/** Har nazorat bo'yicha javobsiz so'rovlar soni (admin kartalari uchun) */
export async function pendingReopenCounts(contentIds: number[]): Promise<Map<number, number>> {
  if (!contentIds.length) return new Map()
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT content_id, COUNT(*) AS n FROM lms_reopen_requests
     WHERE status = 'pending' AND content_id IN (?) GROUP BY content_id`, [contentIds]
  )
  return new Map(rows.map((r) => [Number(r.content_id), Number(r.n)]))
}

export async function createReopenRequest(input: {
  contentId: number
  teacherUserId: number
  teacherName: string
  students: ReopenStudent[]
  reason: string
}): Promise<ReopenRequest> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO lms_reopen_requests (content_id, teacher_user_id, teacher_name, students, reason)
     VALUES (?, ?, ?, ?, ?)`,
    [input.contentId, input.teacherUserId, input.teacherName, JSON.stringify(input.students), input.reason]
  )
  const created = await getReopenRequest(result.insertId)
  if (!created) throw new Error("So'rov saqlanmadi")
  return created
}

/** Faqat "pending" so'rovni o'zgartiradi; aks holda false. */
export async function setReopenRequestStatus(
  id: number,
  status: Exclude<ReopenStatus, "pending">,
  extra: { note?: string | null; reviewer?: string | null; grantedCount?: number } = {}
): Promise<boolean> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE lms_reopen_requests
     SET status = ?, admin_note = ?, reviewed_by_name = ?, granted_count = ?,
         reviewed_at = ${status === "cancelled" ? "NULL" : "CURRENT_TIMESTAMP"}
     WHERE id = ? AND status = 'pending'`,
    [status, extra.note ?? null, extra.reviewer ?? null, extra.grantedCount ?? 0, id]
  )
  return result.affectedRows > 0
}
