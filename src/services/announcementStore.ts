import fs from "fs"
import path from "path"
import type { RowDataPacket } from "mysql2"
import { pool } from "./db"
import { privateStorageRoot, sanitizeFilename, removeStoredFile } from "./teachingStore"

export type AnnouncementAudience = "student" | "employee" | "all"
export type AnnouncementMediaKind = "image" | "video" | "file"

export interface AnnouncementFile {
  fileName: string
  originalName: string
  mimeType: string
  size: number
  relativePath: string
  mediaKind: AnnouncementMediaKind
}

export interface AnnouncementRecord {
  id: number
  title: string | null
  message: string | null
  audience: AnnouncementAudience
  /** Xodim javob yozmaguncha e'lon yopilmaydi (faqat audience = employee) */
  requireReply: boolean
  /** Admin ro'yxati uchun — yozilgan javoblar soni */
  replyCount?: number
  isActive: boolean
  file: AnnouncementFile | null
  createdByUserId: number
  createdByName: string | null
  createdAt: string
  updatedAt: string
}

const ANNOUNCEMENT_ROOT = path.join(privateStorageRoot(), "announcements")

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export function announcementUploadsDir() {
  ensureDir(ANNOUNCEMENT_ROOT)
  return ANNOUNCEMENT_ROOT
}

export function sanitizeAnnouncementFilename(filename: string) {
  return sanitizeFilename(filename)
}

export function mediaKindFromMime(mime: string): AnnouncementMediaKind {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  return "file"
}

function mapRow(row: RowDataPacket): AnnouncementRecord {
  const file: AnnouncementFile | null = row.relative_path
    ? {
        fileName: row.file_name,
        originalName: row.original_name,
        mimeType: row.mime_type,
        size: Number(row.file_size ?? 0),
        relativePath: row.relative_path,
        mediaKind: row.media_kind,
      }
    : null

  return {
    id: row.id,
    title: row.title,
    message: row.message,
    audience: row.audience,
    requireReply: !!row.require_reply,
    ...(row.reply_count !== undefined ? { replyCount: Number(row.reply_count ?? 0) } : {}),
    isActive: !!row.is_active,
    file,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listAllForAdmin(): Promise<AnnouncementRecord[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*, (SELECT COUNT(*) FROM lms_announcement_replies r WHERE r.announcement_id = a.id) AS reply_count
     FROM lms_announcements a ORDER BY a.created_at DESC`
  )
  return rows.map(mapRow)
}

export async function getAnnouncement(id: number): Promise<AnnouncementRecord | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM lms_announcements WHERE id = ?",
    [id]
  )
  return rows[0] ? mapRow(rows[0]) : null
}

interface CreateBaseInput {
  title?: string
  message?: string
  audience: AnnouncementAudience
  requireReply?: boolean
  createdByUserId: number
  createdByName?: string
}

export async function createTextOnly(input: CreateBaseInput): Promise<AnnouncementRecord> {
  const [result] = await pool.query(
    `INSERT INTO lms_announcements
       (title, message, audience, require_reply, created_by_user_id, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.title || null, input.message || null, input.audience, input.requireReply ? 1 : 0, input.createdByUserId, input.createdByName || null]
  )
  const id = (result as { insertId: number }).insertId
  const record = await getAnnouncement(id)
  if (!record) throw new Error("E'lon yaratilmadi")
  return record
}

export async function createWithFile(input: CreateBaseInput & { file: AnnouncementFile }): Promise<AnnouncementRecord> {
  const { file } = input
  const [result] = await pool.query(
    `INSERT INTO lms_announcements
       (title, message, audience, require_reply, file_name, original_name, mime_type, file_size, relative_path, media_kind, created_by_user_id, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title || null,
      input.message || null,
      input.audience,
      input.requireReply ? 1 : 0,
      file.fileName,
      file.originalName,
      file.mimeType,
      file.size,
      file.relativePath,
      file.mediaKind,
      input.createdByUserId,
      input.createdByName || null,
    ]
  )
  const id = (result as { insertId: number }).insertId
  const record = await getAnnouncement(id)
  if (!record) throw new Error("E'lon yaratilmadi")
  return record
}

export async function updateAnnouncement(
  id: number,
  patch: { title?: string | null; message?: string | null; audience?: AnnouncementAudience; requireReply?: boolean }
): Promise<AnnouncementRecord | null> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title) }
  if (patch.message !== undefined) { sets.push("message = ?"); params.push(patch.message) }
  if (patch.audience !== undefined) { sets.push("audience = ?"); params.push(patch.audience) }
  if (patch.requireReply !== undefined) { sets.push("require_reply = ?"); params.push(patch.requireReply ? 1 : 0) }
  if (!sets.length) return getAnnouncement(id)

  params.push(id)
  await pool.query(`UPDATE lms_announcements SET ${sets.join(", ")} WHERE id = ?`, params)
  return getAnnouncement(id)
}

export async function toggleActive(id: number): Promise<AnnouncementRecord | null> {
  const current = await getAnnouncement(id)
  if (!current) return null
  const next = !current.isActive
  await pool.query("UPDATE lms_announcements SET is_active = ? WHERE id = ?", [next, id])

  // Qayta yoqilganda (o'chirilgan holatdan faollashtirilganda) — avval "X"
  // bosib yopib qo'ygan foydalanuvchilarga ham yana ko'rinishi uchun ularning
  // yopish yozuvlarini tozalaymiz. Shu bilan admin e'lonni qayta yaratmasdan,
  // faqat o'chirib-yoqib, hammaga yana yuborishi mumkin.
  if (next) {
    await pool.query("DELETE FROM lms_announcement_dismissals WHERE announcement_id = ?", [id])
  }

  return getAnnouncement(id)
}

export async function deleteAnnouncement(id: number): Promise<boolean> {
  const current = await getAnnouncement(id)
  if (!current) return false
  await pool.query("DELETE FROM lms_announcements WHERE id = ?", [id])
  if (current.file) removeStoredFile(current.file.relativePath)
  return true
}

/**
 * Foydalanuvchi hali yopmagan faol e'lonlar. Yopish yozuvi ROL bilan
 * tekshiriladi (talaba 123 va xodim 123 — turli odamlar); eski yozuvlarda
 * user_role = '' bo'lgani uchun ular ikkala rolga ham tegishli hisoblanadi.
 */
export async function listActiveForUser(role: AnnouncementAudience, userId: number): Promise<(AnnouncementRecord & { replied: boolean })[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.*, (r.id IS NOT NULL) AS replied FROM lms_announcements a
     LEFT JOIN lms_announcement_dismissals d
       ON d.announcement_id = a.id AND d.user_id = ? AND (d.user_role = ? OR d.user_role = '')
     LEFT JOIN lms_announcement_replies r
       ON r.announcement_id = a.id AND r.user_role = ? AND r.user_id = ?
     WHERE a.is_active = 1 AND (a.audience = 'all' OR a.audience = ?) AND d.id IS NULL
     ORDER BY a.created_at DESC`,
    [userId, role, role, userId, role]
  )
  return rows.map((row) => ({ ...mapRow(row), replied: !!row.replied }))
}

// Yo'riqnoma sahifasi uchun: joriy foydalanuvchi auditoriyasiga mos barcha
// FAOL e'lonlar — foydalanuvchi popup'ni "X" bosib yopgan (dismiss qilgan)
// bo'lishidan qat'iy nazar. listActiveForUser'dan farqi shu — u yerda
// yopilgan e'lon boshqa qaytmaydi (bir martalik popup), bu yerda esa
// Yo'riqnoma doimiy ko'rinib turishi kerak bo'lgani uchun dismiss'ga
// qaramaydi.
export async function listActiveForAudience(role: AnnouncementAudience): Promise<AnnouncementRecord[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_announcements
     WHERE is_active = 1 AND (audience = 'all' OR audience = ?)
     ORDER BY created_at DESC`,
    [role]
  )
  return rows.map(mapRow)
}

/**
 * E'lonlarni yopish. "Javob talab qilinsin" e'loni foydalanuvchi javob
 * yozmaguncha yopilmaydi — bu server tomonda ham tekshiriladi (faqat
 * tugmani yashirish yetarli emas).
 */
export async function dismissForUser(role: string, userId: number, announcementIds: number[]): Promise<void> {
  for (const id of announcementIds) {
    await pool.query(
      `INSERT IGNORE INTO lms_announcement_dismissals (announcement_id, user_role, user_id)
       SELECT a.id, ?, ? FROM lms_announcements a
       LEFT JOIN lms_announcement_replies r ON r.announcement_id = a.id AND r.user_role = ? AND r.user_id = ?
       WHERE a.id = ? AND (a.require_reply = 0 OR r.id IS NOT NULL)`,
      [role, userId, role, userId, id]
    )
  }
}

export interface AnnouncementReply {
  id: number
  userRole: string
  userId: number
  fullName: string | null
  body: string
  createdAt: string
}

/** Javobni saqlaydi (qayta yozsa — yangilanadi) va e'lonni shu foydalanuvchi uchun yopadi. */
export async function saveReply(
  announcementId: number,
  role: string,
  userId: number,
  fullName: string | null,
  body: string
): Promise<void> {
  await pool.query(
    `INSERT INTO lms_announcement_replies (announcement_id, user_role, user_id, full_name, body)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE body = VALUES(body), full_name = VALUES(full_name), created_at = CURRENT_TIMESTAMP`,
    [announcementId, role, userId, fullName, body]
  )
  await pool.query(
    "INSERT IGNORE INTO lms_announcement_dismissals (announcement_id, user_role, user_id) VALUES (?, ?, ?)",
    [announcementId, role, userId]
  )
}

export async function listReplies(announcementId: number): Promise<AnnouncementReply[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, user_role, user_id, full_name, body, created_at
     FROM lms_announcement_replies WHERE announcement_id = ?
     ORDER BY created_at DESC`,
    [announcementId]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userRole: String(r.user_role),
    userId: Number(r.user_id),
    fullName: r.full_name ? String(r.full_name) : null,
    body: String(r.body),
    createdAt: new Date(r.created_at).toISOString(),
  }))
}
