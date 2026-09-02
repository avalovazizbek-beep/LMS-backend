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
    "SELECT * FROM lms_announcements ORDER BY created_at DESC"
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
  createdByUserId: number
  createdByName?: string
}

export async function createTextOnly(input: CreateBaseInput): Promise<AnnouncementRecord> {
  const [result] = await pool.query(
    `INSERT INTO lms_announcements
       (title, message, audience, created_by_user_id, created_by_name)
     VALUES (?, ?, ?, ?, ?)`,
    [input.title || null, input.message || null, input.audience, input.createdByUserId, input.createdByName || null]
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
       (title, message, audience, file_name, original_name, mime_type, file_size, relative_path, media_kind, created_by_user_id, created_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.title || null,
      input.message || null,
      input.audience,
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
  patch: { title?: string | null; message?: string | null; audience?: AnnouncementAudience }
): Promise<AnnouncementRecord | null> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title) }
  if (patch.message !== undefined) { sets.push("message = ?"); params.push(patch.message) }
  if (patch.audience !== undefined) { sets.push("audience = ?"); params.push(patch.audience) }
  if (!sets.length) return getAnnouncement(id)

  params.push(id)
  await pool.query(`UPDATE lms_announcements SET ${sets.join(", ")} WHERE id = ?`, params)
  return getAnnouncement(id)
}

export async function toggleActive(id: number): Promise<AnnouncementRecord | null> {
  const current = await getAnnouncement(id)
  if (!current) return null
  await pool.query("UPDATE lms_announcements SET is_active = ? WHERE id = ?", [!current.isActive, id])
  return getAnnouncement(id)
}

export async function deleteAnnouncement(id: number): Promise<boolean> {
  const current = await getAnnouncement(id)
  if (!current) return false
  await pool.query("DELETE FROM lms_announcements WHERE id = ?", [id])
  if (current.file) removeStoredFile(current.file.relativePath)
  return true
}

export async function listActiveForUser(role: AnnouncementAudience, userId: number): Promise<AnnouncementRecord[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.* FROM lms_announcements a
     LEFT JOIN lms_announcement_dismissals d ON d.announcement_id = a.id AND d.user_id = ?
     WHERE a.is_active = 1 AND (a.audience = 'all' OR a.audience = ?) AND d.id IS NULL
     ORDER BY a.created_at DESC`,
    [userId, role]
  )
  return rows.map(mapRow)
}

export async function dismissForUser(userId: number, announcementIds: number[]): Promise<void> {
  for (const id of announcementIds) {
    await pool.query(
      "INSERT IGNORE INTO lms_announcement_dismissals (announcement_id, user_id) VALUES (?, ?)",
      [id, userId]
    )
  }
}
