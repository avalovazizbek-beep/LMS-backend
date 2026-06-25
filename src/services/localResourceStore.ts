import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import type mysql from "mysql2/promise"
import { pool } from "./db"

export type LocalResourceKind =
  | "lecture"
  | "presentation"
  | "laboratory"
  | "video_lesson"
  | "meeting_video"
  | "other"

export interface LocalResourceRecord {
  id: string
  subjectId?: string
  subjectName: string
  title: string
  comment?: string
  kind: LocalResourceKind
  trainingTypeName: string
  employeeName?: string
  meetingId?: string
  externalUrl?: string
  isActive: boolean
  file: {
    name: string
    originalName: string
    mimeType: string
    size: number
    relativePath: string
    url: string
  }
  createdAt: string
  updatedAt: string
}

export interface CreateLocalResourceInput {
  subjectId?: string
  subjectName: string
  title?: string
  comment?: string
  kind?: string
  trainingTypeName?: string
  employeeName?: string
  meetingId?: string
  externalUrl?: string
  originalName: string
  mimeType: string
  size: number
  relativePath: string
  url: string
}

export interface UpdateLocalResourceInput {
  title?: string
  comment?: string | null
  externalUrl?: string | null
  isActive?: boolean
}

const STORAGE_ROOT = path.resolve(process.env.LOCAL_RESOURCE_STORAGE || path.join(process.cwd(), "storage"))
const FILE_ROOT = path.join(STORAGE_ROOT, "uploads", "resources")

function ensureStorage() {
  fs.mkdirSync(FILE_ROOT, { recursive: true })
}

function normalizeKind(value?: string): LocalResourceKind {
  if (
    value === "lecture" ||
    value === "presentation" ||
    value === "laboratory" ||
    value === "video_lesson" ||
    value === "meeting_video" ||
    value === "other"
  ) {
    return value
  }
  return "other"
}

function mapRow(row: mysql.RowDataPacket): LocalResourceRecord {
  return {
    id: String(row.id),
    subjectId: row.subject_id || undefined,
    subjectName: String(row.subject_name),
    title: String(row.title),
    comment: row.comment || undefined,
    kind: normalizeKind(row.kind),
    trainingTypeName: String(row.training_type_name),
    employeeName: row.employee_name || undefined,
    meetingId: row.meeting_id == null ? undefined : String(row.meeting_id),
    externalUrl: row.external_url || undefined,
    isActive: row.is_active == null ? true : Boolean(row.is_active),
    file: {
      name: String(row.file_name),
      originalName: String(row.original_name),
      mimeType: String(row.mime_type),
      size: Number(row.file_size),
      relativePath: String(row.relative_path),
      url: String(row.public_url),
    },
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  }
}

export function resourceUploadsDir() {
  ensureStorage()
  return FILE_ROOT
}

export function publicResourcePath() {
  return path.join(STORAGE_ROOT, "uploads")
}

export async function listLocalResources(filter?: {
  subjectName?: string
  kind?: string
  groupId?: number | null
  userRole?: string
}) {
  const where: string[] = []
  const params: unknown[] = []

  const kind = filter?.kind?.trim() ? normalizeKind(filter.kind) : undefined

  if (filter?.subjectName?.trim()) {
    where.push("LOWER(sr.subject_name) = LOWER(?)")
    params.push(filter.subjectName.trim())
  }
  if (kind) {
    where.push("sr.kind = ?")
    params.push(kind)
  }

  // Filter meeting_video by student's group
  let joinClause = ""
  if (
    kind === "meeting_video" &&
    filter?.userRole === "student" &&
    filter?.groupId != null
  ) {
    joinClause = `INNER JOIN lms_meeting_groups mg ON mg.meeting_id = sr.meeting_id AND mg.group_id = ?`
    params.unshift(filter.groupId)
  }

  const sql = `SELECT sr.* FROM lms_subject_resources sr ${joinClause}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY sr.updated_at DESC`
  const [rows] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return rows.map(mapRow)
}

export async function addLocalResource(input: CreateLocalResourceInput) {
  const id = randomUUID()
  const kind = normalizeKind(input.kind)
  await pool.query(
    `INSERT INTO lms_subject_resources
      (id, subject_id, subject_name, title, comment, kind, training_type_name, employee_name, meeting_id,
       file_name, original_name, mime_type, file_size, relative_path, public_url, external_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.subjectId?.trim() || null,
      input.subjectName.trim(),
      input.title?.trim() || input.originalName,
      input.comment?.trim() || null,
      kind,
      input.trainingTypeName?.trim() || kindLabel(kind),
      input.employeeName?.trim() || null,
      input.meetingId ? Number(input.meetingId) || null : null,
      input.originalName,
      input.originalName,
      input.mimeType,
      input.size,
      input.relativePath,
      input.url,
      input.externalUrl?.trim() || null,
    ]
  )
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_subject_resources WHERE id = ?", [id])
  return mapRow(rows[0])
}

export async function updateLocalResource(id: string, patch: UpdateLocalResourceInput) {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) {
    sets.push("title = ?")
    params.push(patch.title.trim())
  }
  if (patch.comment !== undefined) {
    sets.push("comment = ?")
    params.push(patch.comment?.trim() || null)
  }
  if (patch.externalUrl !== undefined) {
    sets.push("external_url = ?")
    params.push(patch.externalUrl?.trim() || null)
  }
  if (patch.isActive !== undefined) {
    sets.push("is_active = ?")
    params.push(patch.isActive ? 1 : 0)
  }
  if (sets.length) {
    params.push(id)
    await pool.query(`UPDATE lms_subject_resources SET ${sets.join(", ")} WHERE id = ?`, params)
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_subject_resources WHERE id = ?", [id])
  return rows.length ? mapRow(rows[0]) : null
}

export async function deleteLocalResource(id: string) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_subject_resources WHERE id = ?", [id])
  if (!rows.length) return false
  await pool.query("DELETE FROM lms_subject_resources WHERE id = ?", [id])
  return true
}

export function kindLabel(kind: LocalResourceKind) {
  const labels: Record<LocalResourceKind, string> = {
    lecture: "Ma'ruza",
    presentation: "Taqdimot",
    laboratory: "Laboratoriya",
    video_lesson: "Video dars",
    meeting_video: "Meeting video",
    other: "Boshqa",
  }
  return labels[kind]
}

export async function localResourcesAsHemisResources(filter?: { subjectName?: string }) {
  const resources = await listLocalResources(filter)
  return resources.map((item) => ({
    id: `local-${item.id}`,
    title: item.title,
    comment: item.comment,
    subject: {
      id: item.subjectId || item.subjectName,
      name: item.subjectName,
    },
    trainingType: {
      code: item.kind,
      name: item.trainingTypeName,
    },
    employee: item.employeeName ? { id: "local", name: item.employeeName } : undefined,
    active: true,
    updated_at: Math.floor(Date.parse(item.updatedAt) / 1000),
    subjectFileResourceItems: [
      {
        id: item.id,
        comment: item.comment,
        resourceType: {
          code: item.kind,
          name: kindLabel(item.kind),
        },
        url: item.file.url,
        updated_at: Math.floor(Date.parse(item.updatedAt) / 1000),
        files: [
          {
            name: item.file.originalName,
            size: item.file.size,
            url: item.file.url,
          },
        ],
      },
    ],
  }))
}
