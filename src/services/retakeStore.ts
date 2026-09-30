import type mysql from "mysql2/promise"
import { pool, fromMysqlDate } from "./db"
import { listSubmissions } from "./teachingStore"
import { isExamPassed } from "./examStore"
import { notifySafe } from "./notificationStore"

export type RetakeGrantStatus = "active" | "used" | "revoked"

export interface RetakeGrantRecord {
  id: number
  contentId: number
  studentUserId: number
  status: RetakeGrantStatus
  grantedBy: string | null
  reason: string | null
  grantedAt: string
  usedAt: string | null
  revokedAt: string | null
}

function mapRow(row: mysql.RowDataPacket): RetakeGrantRecord {
  return {
    id: Number(row.id),
    contentId: Number(row.content_id),
    studentUserId: Number(row.student_user_id),
    status: row.status as RetakeGrantStatus,
    grantedBy: row.granted_by ?? null,
    reason: row.reason ?? null,
    grantedAt: fromMysqlDate(row.granted_at),
    usedAt: row.used_at ? fromMysqlDate(row.used_at) : null,
    revokedAt: row.revoked_at ? fromMysqlDate(row.revoked_at) : null,
  }
}

export async function getActiveRetakeGrant(contentId: number, studentUserId: number): Promise<RetakeGrantRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_exam_retake_grants WHERE content_id = ? AND student_user_id = ? AND status = 'active' LIMIT 1",
    [contentId, studentUserId]
  )
  return rows.length ? mapRow(rows[0]) : null
}

/** Idempotent: agar shu talaba uchun faol ruxsat allaqachon bo'lsa, mavjudini qaytaradi. */
export async function grantRetake(contentId: number, studentUserId: number, grantedBy: string | null, reason?: string | null): Promise<RetakeGrantRecord> {
  const existing = await getActiveRetakeGrant(contentId, studentUserId)
  if (existing) return existing
  await pool.query(
    "INSERT INTO lms_exam_retake_grants (content_id, student_user_id, granted_by, reason) VALUES (?, ?, ?, ?)",
    [contentId, studentUserId, grantedBy, reason?.trim() || null]
  )
  const created = await getActiveRetakeGrant(contentId, studentUserId)
  if (!created) throw new Error("Retake grant saqlanmadi")
  return created
}

export async function consumeRetakeGrant(contentId: number, studentUserId: number): Promise<void> {
  await pool.query(
    "UPDATE lms_exam_retake_grants SET status='used', used_at=CURRENT_TIMESTAMP WHERE content_id=? AND student_user_id=? AND status='active'",
    [contentId, studentUserId]
  )
}

export async function revokeRetakeGrant(contentId: number, studentUserId: number): Promise<void> {
  await pool.query(
    "UPDATE lms_exam_retake_grants SET status='revoked', revoked_at=CURRENT_TIMESTAMP WHERE content_id=? AND student_user_id=? AND status='active'",
    [contentId, studentUserId]
  )
}

/** Tanlangan talabalarga bir martalik qo'shimcha urinish beradi — admin
    paneli ham, o'qituvchi ham shu yo'ldan foydalanadi. Testdan allaqachon
    o'tgan talaba o'tkazib yuboriladi (bahosi pasayib ketmasligi uchun).
    Yangi ruxsat olgan talabaga bildirishnoma boradi. Nechta talabaga
    ruxsat berilganini qaytaradi. */
export async function grantRetakesForContent(
  content: { id: number; title: string; maxScore: number | null },
  studentUserIds: number[],
  grantedBy: string | null,
  reason?: string | null
): Promise<number> {
  const submissions = await listSubmissions(content.id)
  const byStudent = new Map(submissions.map((s) => [s.studentUserId, s]))
  let granted = 0
  for (const studentId of new Set(studentUserIds)) {
    const sub = byStudent.get(studentId)
    if (sub && isExamPassed(sub.grade, content.maxScore)) continue
    const already = await getActiveRetakeGrant(content.id, studentId)
    await grantRetake(content.id, studentId, grantedBy, reason)
    granted++
    if (!already) {
      notifySafe({
        role: "student",
        userId: studentId,
        type: "teacher",
        title: "Qayta urinish ruxsati berildi",
        body: `${content.title}: sizga yana bir urinish berildi`,
        i18nKey: "retakeGranted",
        i18nParams: { title: content.title },
      })
    }
  }
  return granted
}
