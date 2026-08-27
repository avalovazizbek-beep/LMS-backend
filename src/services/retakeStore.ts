import type mysql from "mysql2/promise"
import { pool, fromMysqlDate } from "./db"

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
