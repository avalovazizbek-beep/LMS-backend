import fs from "fs"
import path from "path"
import { randomUUID, randomBytes } from "crypto"
import type mysql from "mysql2/promise"
import { pool, toMysqlDate, fromMysqlDate } from "./db"
import { stableNumericId } from "./meetingStore"

export type ContentType =
  | "lesson"
  | "assignment"
  | "exam"
  | "mavzu"
  | "kurs-topshiriq"
  | "kalendar"
  | "malumot"
export type ContentStatus = "locked" | "open" | "closed"

const WEEK_DAYS = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"]

export function weekDayName(date: Date) {
  return WEEK_DAYS[date.getDay()]
}

export function toMysqlDateOnly(date: Date) {
  return date.toISOString().slice(0, 10)
}

/* ── Foydalanuvchi ID'larini barqaror son ko'rinishiga keltirish ──────
   meetingStore.resolveMeetingUser bilan bir xil qoidaga amal qiladi, shu
   sababli bir xil HEMIS foydalanuvchisi turli jadvallarda bir xil
   `*_user_id` qiymatiga ega bo'ladi. */
export function teacherUserId(user?: { id?: string | number; userId?: string | number }) {
  return stableNumericId(user?.id ?? user?.userId, 9001)
}

export function studentUserId(user?: { id?: string | number; userId?: string | number }) {
  return stableNumericId(user?.id ?? user?.userId, 9101)
}

/* ── Fayl saqlash ──────────────────────────────────────────────────────
   MUHIM: bu fayllar `STORAGE_ROOT/uploads` (statik `/uploads` yo'li) ICHIDA
   EMAS — chunki dedline tugamaguncha qulflangan kontent faylini hech kim
   to'g'ridan-to'g'ri statik havola orqali ocha olmasligi kerak. Fayllarga
   faqat `routes/teaching.ts`dagi token-tekshiruvchi `/content/:id/file` va
   `/submissions/:id/file` endpointlari orqali, holat (locked/open/closed)
   tekshirilgandan keyingina kirish mumkin. ───────────────────────────── */
const STORAGE_ROOT = path.resolve(process.env.LOCAL_RESOURCE_STORAGE || path.join(process.cwd(), "storage"))
const PRIVATE_ROOT = path.join(STORAGE_ROOT, "private")
const TEACHING_FILE_ROOT = path.join(PRIVATE_ROOT, "teaching")
const SUBMISSION_FILE_ROOT = path.join(PRIVATE_ROOT, "submissions")
const QUESTION_IMAGES_ROOT = path.join(STORAGE_ROOT, "question-images")

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export function teachingUploadsDir() {
  ensureDir(TEACHING_FILE_ROOT)
  return TEACHING_FILE_ROOT
}

export function submissionUploadsDir() {
  ensureDir(SUBMISSION_FILE_ROOT)
  return SUBMISSION_FILE_ROOT
}

export function privateStorageRoot() {
  return PRIVATE_ROOT
}

/** Savol rasmlari (MCQ) — auth talab qilinmaydi, to'g'ridan-to'g'ri <img> da ishlatish uchun */
export function questionImagesDir() {
  ensureDir(QUESTION_IMAGES_ROOT)
  return QUESTION_IMAGES_ROOT
}

export function sanitizeFilename(filename: string) {
  const parsed = path.parse(filename || "file")
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "file"
  const ext = (parsed.ext || "").toLowerCase()
  return `${base.slice(0, 80)}-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`
}

export function removeStoredFile(relativePath?: string | null) {
  if (!relativePath) return
  const absolute = path.join(PRIVATE_ROOT, relativePath.replace(/^\/+/, ""))
  fs.rm(absolute, { force: true }, () => undefined)
}

/* ── Dedline holati ────────────────────────────────────────────────── */
export function contentStatus(now: Date, availableFrom: string, deadline: string | null): ContentStatus {
  const start = new Date(availableFrom).getTime()
  const end = deadline ? new Date(deadline).getTime() : null
  const t = now.getTime()
  if (Number.isFinite(start) && t < start) return "locked"
  if (end !== null && Number.isFinite(end) && t > end) return "closed"
  return "open"
}

/* ── Guruhlar va dars jadvali (HEMIS sinxronizatsiyasi) ────────────── */
export interface SyncedGroup {
  id: number
  name: string
  direction?: string | null
  course?: number | null
}

export interface TeacherScheduleInput {
  groupId: number | null
  subjectName: string
  weekDay: string | null
  lessonDate: string | null
  startTime: string | null
  endTime: string | null
  room: string | null
  raw?: unknown
}

export async function upsertGroups(groups: SyncedGroup[]) {
  for (const g of groups) {
    await pool.query(
      `INSERT INTO lms_groups (id, name, direction, course)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name      = VALUES(name),
         direction = COALESCE(VALUES(direction), direction),
         course    = COALESCE(VALUES(course), course)`,
      [g.id, g.name, g.direction ?? null, g.course ?? null]
    )
  }
}

export async function replaceTeacherGroups(userId: number, groupIds: number[]) {
  await pool.query("DELETE FROM lms_teacher_groups WHERE user_id = ?", [userId])
  for (const gid of groupIds) {
    await pool.query("INSERT IGNORE INTO lms_teacher_groups (user_id, group_id) VALUES (?, ?)", [userId, gid])
  }
}

export async function replaceTeacherSchedule(userId: number, rows: TeacherScheduleInput[]) {
  await pool.query("DELETE FROM lms_teacher_schedule WHERE teacher_user_id = ?", [userId])
  for (const row of rows) {
    await pool.query(
      `INSERT INTO lms_teacher_schedule
        (teacher_user_id, group_id, subject_name, week_day, lesson_date, start_time, end_time, room, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        row.groupId,
        row.subjectName,
        row.weekDay,
        row.lessonDate,
        row.startTime,
        row.endTime,
        row.room,
        JSON.stringify(row.raw ?? {}),
      ]
    )
  }
}

/** HEMIS'dan kelgan guruh va jadval ma'lumotlarini birgalikda o'z bazamizga yozadi. */
export async function syncTeacherGroupsAndSchedule(userId: number, groups: SyncedGroup[], schedule: TeacherScheduleInput[]) {
  if (groups.length) await upsertGroups(groups)
  await replaceTeacherGroups(userId, groups.map((g) => g.id))
  await replaceTeacherSchedule(userId, schedule)
}

export async function getTeacherGroupIds(userId: number): Promise<number[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT DISTINCT group_id FROM (
       SELECT group_id FROM lms_teacher_groups WHERE user_id = ?
       UNION
       SELECT group_id FROM lms_teacher_content WHERE teacher_user_id = ? AND is_active = 1 AND group_id IS NOT NULL
     ) g ORDER BY group_id`,
    [userId, userId]
  )
  return rows.map((r) => Number(r.group_id))
}

export interface GroupRecord {
  id: number
  name: string
  direction: string | null
  course: number | null
}

function mapGroupRow(row: mysql.RowDataPacket): GroupRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    direction: row.direction ?? null,
    course: row.course == null ? null : Number(row.course),
  }
}

export async function getTeacherGroups(userId: number): Promise<GroupRecord[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT DISTINCT g.* FROM (
       SELECT group_id FROM lms_teacher_groups WHERE user_id = ?
       UNION
       SELECT group_id FROM lms_teacher_content WHERE teacher_user_id = ? AND is_active = 1 AND group_id IS NOT NULL
     ) combined
     JOIN lms_groups g ON g.id = combined.group_id
     ORDER BY g.name`,
    [userId, userId]
  )
  return rows.map(mapGroupRow)
}

export async function getGroupById(groupId: number): Promise<GroupRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_groups WHERE id = ?", [groupId])
  return rows.length ? mapGroupRow(rows[0]) : null
}

export async function replaceTeacherSubjects(userId: number, subjectNames: string[]) {
  await pool.query("DELETE FROM lms_teacher_subjects WHERE user_id = ?", [userId])
  for (const name of subjectNames) {
    await pool.query("INSERT IGNORE INTO lms_teacher_subjects (user_id, subject_name) VALUES (?, ?)", [userId, name])
  }
}

export async function getTeacherSubjects(userId: number): Promise<string[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT subject_name FROM lms_teacher_subjects WHERE user_id = ? ORDER BY subject_name",
    [userId]
  )
  return rows.map((r) => String(r.subject_name))
}

export interface TeacherScheduleRecord {
  id: number
  groupId: number | null
  subjectName: string
  weekDay: string | null
  lessonDate: string | null
  startTime: string | null
  endTime: string | null
  room: string | null
  syncedAt: string
}

export async function getTeacherSchedule(userId: number): Promise<TeacherScheduleRecord[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_teacher_schedule WHERE teacher_user_id = ? ORDER BY lesson_date, start_time",
    [userId]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    groupId: r.group_id == null ? null : Number(r.group_id),
    subjectName: String(r.subject_name),
    weekDay: r.week_day ?? null,
    lessonDate: r.lesson_date ? String(r.lesson_date).slice(0, 10) : null,
    startTime: r.start_time ?? null,
    endTime: r.end_time ?? null,
    room: r.room ?? null,
    syncedAt: fromMysqlDate(r.synced_at),
  }))
}

/* ── O'qituvchi yuklagan kontent (darslik / topshiriq / imtihon) ──── */
export interface ContentFile {
  name: string
  originalName: string
  mimeType: string
  size: number
  relativePath: string
  url: string
}

export interface TeacherContentRecord {
  id: number
  uuid: string
  type: ContentType
  teacherUserId: number
  groupId: number
  subjectName: string
  topicKey: string | null
  title: string
  description: string | null
  kind: string | null
  controlType: string | null
  resourceType: string | null
  meetingLink: string | null
  file: ContentFile | null
  files: ContentFile[]
  availableFrom: string
  deadline: string | null
  maxScore: number | null
  attemptsCount: number | null
  questionDisplayCount: number | null
  language: string | null
  durationMinutes: number | null
  trainingLoad: number | null
  completionPoints: number | null
  lessonDate: string | null
  delivered: boolean
  isActive: boolean
  status: ContentStatus
  questionCount: number
  createdAt: string
  updatedAt: string
}

/* `SELECT *` ga qo'shimcha — har bir kontent uchun bog'langan imtihon
   savollari sonini hisoblaydi (imtihon yaratishda emas, faqat o'qishda). */
const CONTENT_SELECT = `
  lms_teacher_content.*,
  (SELECT COUNT(*) FROM lms_exam_questions WHERE content_id = lms_teacher_content.id) AS question_count
`

function mapContentFileRow(row: mysql.RowDataPacket, contentId: number): ContentFile {
  return {
    name: String(row.file_name),
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    size: Number(row.file_size),
    relativePath: String(row.relative_path),
    url: `/api/teaching/content/${contentId}/files/${Number(row.id)}`,
  }
}

export async function getContentFiles(contentId: number): Promise<ContentFile[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_teacher_content_files WHERE content_id = ? ORDER BY id",
    [contentId]
  )
  return rows.map((row) => mapContentFileRow(row, contentId))
}

async function mapContentRow(row: mysql.RowDataPacket): Promise<TeacherContentRecord> {
  const availableFrom = fromMysqlDate(row.available_from)
  const deadline = row.deadline ? fromMysqlDate(row.deadline) : null
  const id = Number(row.id)
  return {
    id,
    uuid: String(row.uuid),
    type: row.type as ContentType,
    teacherUserId: Number(row.teacher_user_id),
    groupId: Number(row.group_id),
    subjectName: String(row.subject_name),
    topicKey: row.topic_key ?? null,
    title: String(row.title),
    description: row.description ?? null,
    kind: row.kind ?? null,
    controlType: row.control_type ?? null,
    resourceType: row.resource_type ?? null,
    meetingLink: row.meeting_link ?? null,
    file: row.file_name
      ? {
          name: String(row.file_name),
          originalName: String(row.original_name),
          mimeType: String(row.mime_type),
          size: Number(row.file_size),
          relativePath: String(row.relative_path),
          // Statik /uploads orqali emas — token-tekshiruvchi, dedlineni
          // hisobga oluvchi endpoint orqaligina ochiladi (locked bo'lsa 403).
          url: `/api/teaching/content/${id}/file`,
        }
      : null,
    files: await getContentFiles(id),
    availableFrom,
    deadline,
    maxScore: row.max_score == null ? null : Number(row.max_score),
    attemptsCount: row.attempts_count == null ? null : Number(row.attempts_count),
    questionDisplayCount: row.question_display_count == null ? null : Number(row.question_display_count),
    language: row.language ?? null,
    durationMinutes: row.duration_minutes == null ? null : Number(row.duration_minutes),
    trainingLoad: row.training_load == null ? null : Number(row.training_load),
    completionPoints: row.completion_points == null ? null : Number(row.completion_points),
    lessonDate: row.lesson_date ? toMysqlDateOnly(new Date(row.lesson_date)) : null,
    delivered: Boolean(row.delivered),
    isActive: row.is_active == null ? true : Boolean(row.is_active),
    status: contentStatus(new Date(), availableFrom, deadline),
    questionCount: row.question_count == null ? 0 : Number(row.question_count),
    createdAt: fromMysqlDate(row.created_at),
    updatedAt: fromMysqlDate(row.updated_at),
  }
}

export interface CreateContentInput {
  type: ContentType
  teacherUserId: number
  groupId: number
  subjectName: string
  topicKey?: string | null
  title: string
  description?: string | null
  kind?: string | null
  controlType?: string | null
  resourceType?: string | null
  meetingLink?: string | null
  availableFrom: string
  deadline?: string | null
  maxScore?: number | null
  attemptsCount?: number | null
  language?: string | null
  completionPoints?: number | null
  durationMinutes?: number | null
  trainingLoad?: number | null
  lessonDate?: string | null
  delivered?: boolean
  file?: ContentFile | null
}

export async function createTeacherContent(input: CreateContentInput): Promise<TeacherContentRecord> {
  const uuid = randomUUID()
  await pool.query(
    `INSERT INTO lms_teacher_content
      (uuid, type, teacher_user_id, group_id, subject_name, topic_key, title, description, kind, control_type, resource_type,
       file_name, original_name, mime_type, file_size, relative_path, public_url, meeting_link,
       available_from, deadline, max_score, attempts_count, language, duration_minutes, training_load, completion_points, lesson_date, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      input.type,
      input.teacherUserId,
      input.groupId,
      input.subjectName.trim(),
      input.topicKey?.trim() || null,
      input.title.trim(),
      input.description?.trim() || null,
      input.kind?.trim() || null,
      input.controlType?.trim() || null,
      input.resourceType?.trim() || null,
      input.file?.name ?? null,
      input.file?.originalName ?? null,
      input.file?.mimeType ?? null,
      input.file?.size ?? null,
      input.file?.relativePath ?? null,
      input.file?.url ?? null,
      input.meetingLink?.trim() || null,
      toMysqlDate(new Date(input.availableFrom)),
      input.deadline ? toMysqlDate(new Date(input.deadline)) : null,
      input.maxScore ?? null,
      input.attemptsCount ?? null,
      input.language?.trim() || null,
      input.durationMinutes ?? null,
      input.trainingLoad ?? null,
      input.completionPoints ?? null,
      input.lessonDate ? input.lessonDate.slice(0, 10) : null,
      input.delivered ? 1 : 0,
    ]
  )
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT ${CONTENT_SELECT} FROM lms_teacher_content WHERE uuid = ?`,
    [uuid]
  )
  return mapContentRow(rows[0])
}

export async function addContentFile(contentId: number, file: ContentFile): Promise<ContentFile[]> {
  await pool.query(
    `INSERT INTO lms_teacher_content_files (content_id, file_name, original_name, mime_type, file_size, relative_path)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [contentId, file.name, file.originalName, file.mimeType, file.size, file.relativePath]
  )
  return getContentFiles(contentId)
}

export interface ContentFileRecord extends ContentFile {
  id: number
}

export async function getContentFile(contentId: number, fileId: number): Promise<ContentFileRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_teacher_content_files WHERE content_id = ? AND id = ?",
    [contentId, fileId]
  )
  if (!rows.length) return null
  return { id: fileId, ...mapContentFileRow(rows[0], contentId) }
}

export async function removeContentFile(contentId: number, fileId: number): Promise<boolean> {
  const file = await getContentFile(contentId, fileId)
  if (!file) return false
  await pool.query("DELETE FROM lms_teacher_content_files WHERE content_id = ? AND id = ?", [contentId, fileId])
  removeStoredFile(file.relativePath)
  return true
}

export interface ContentFilter {
  type?: ContentType
  teacherUserId?: number
  groupId?: number
  subjectName?: string
  topicKey?: string
  isActive?: boolean
}

export async function listTeacherContent(filter: ContentFilter): Promise<TeacherContentRecord[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.type) {
    where.push("type = ?")
    params.push(filter.type)
  }
  if (filter.teacherUserId != null) {
    where.push("teacher_user_id = ?")
    params.push(filter.teacherUserId)
  }
  if (filter.groupId != null) {
    where.push("group_id = ?")
    params.push(filter.groupId)
  }
  if (filter.subjectName?.trim()) {
    where.push("LOWER(subject_name) = LOWER(?)")
    params.push(filter.subjectName.trim())
  }
  if (filter.topicKey?.trim()) {
    where.push("topic_key = ?")
    params.push(filter.topicKey.trim())
  }
  if (filter.isActive !== undefined) {
    where.push("is_active = ?")
    params.push(filter.isActive ? 1 : 0)
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT ${CONTENT_SELECT} FROM lms_teacher_content ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY available_from DESC`,
    params
  )
  return Promise.all(rows.map(mapContentRow))
}

export async function getTeacherContent(id: number): Promise<TeacherContentRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT ${CONTENT_SELECT} FROM lms_teacher_content WHERE id = ?`,
    [id]
  )
  return rows.length ? mapContentRow(rows[0]) : null
}

export interface UpdateContentInput {
  title?: string
  description?: string | null
  subjectName?: string
  kind?: string | null
  controlType?: string | null
  availableFrom?: string
  deadline?: string | null
  maxScore?: number | null
  attemptsCount?: number | null
  questionDisplayCount?: number | null
  language?: string | null
  completionPoints?: number | null
  durationMinutes?: number | null
  trainingLoad?: number | null
  lessonDate?: string | null
  delivered?: boolean
  isActive?: boolean
}

export async function updateTeacherContent(id: number, patch: UpdateContentInput): Promise<TeacherContentRecord | null> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) {
    sets.push("title = ?")
    params.push(patch.title.trim())
  }
  if (patch.description !== undefined) {
    sets.push("description = ?")
    params.push(patch.description?.trim() || null)
  }
  if (patch.subjectName !== undefined) {
    sets.push("subject_name = ?")
    params.push(patch.subjectName.trim())
  }
  if (patch.kind !== undefined) {
    sets.push("kind = ?")
    params.push(patch.kind?.trim() || null)
  }
  if (patch.controlType !== undefined) {
    sets.push("control_type = ?")
    params.push(patch.controlType?.trim() || null)
  }
  if (patch.attemptsCount !== undefined) {
    sets.push("attempts_count = ?")
    params.push(patch.attemptsCount)
  }
  if (patch.questionDisplayCount !== undefined) {
    sets.push("question_display_count = ?")
    params.push(patch.questionDisplayCount)
  }
  if (patch.language !== undefined) {
    sets.push("language = ?")
    params.push(patch.language?.trim() || null)
  }
  if (patch.availableFrom !== undefined) {
    sets.push("available_from = ?")
    params.push(toMysqlDate(new Date(patch.availableFrom)))
  }
  if (patch.deadline !== undefined) {
    sets.push("deadline = ?")
    params.push(patch.deadline ? toMysqlDate(new Date(patch.deadline)) : null)
  }
  if (patch.maxScore !== undefined) {
    sets.push("max_score = ?")
    params.push(patch.maxScore)
  }
  if (patch.completionPoints !== undefined) {
    sets.push("completion_points = ?")
    params.push(patch.completionPoints)
  }
  if (patch.durationMinutes !== undefined) {
    sets.push("duration_minutes = ?")
    params.push(patch.durationMinutes)
  }
  if (patch.trainingLoad !== undefined) {
    sets.push("training_load = ?")
    params.push(patch.trainingLoad)
  }
  if (patch.lessonDate !== undefined) {
    sets.push("lesson_date = ?")
    params.push(patch.lessonDate ? patch.lessonDate.slice(0, 10) : null)
  }
  if (patch.delivered !== undefined) {
    sets.push("delivered = ?")
    params.push(patch.delivered ? 1 : 0)
  }
  if (patch.isActive !== undefined) {
    sets.push("is_active = ?")
    params.push(patch.isActive ? 1 : 0)
  }
  if (!sets.length) return getTeacherContent(id)
  params.push(id)
  await pool.query(`UPDATE lms_teacher_content SET ${sets.join(", ")} WHERE id = ?`, params)
  return getTeacherContent(id)
}

export async function deleteTeacherContent(id: number): Promise<boolean> {
  const content = await getTeacherContent(id)
  if (!content) return false
  await pool.query("DELETE FROM lms_teacher_content WHERE id = ?", [id])
  await pool.query("DELETE FROM lms_teacher_content_files WHERE content_id = ?", [id])
  removeStoredFile(content.file?.relativePath)
  content.files.forEach((file) => removeStoredFile(file.relativePath))
  return true
}

/* ── Talaba topshirgan ishlar ──────────────────────────────────────── */
export interface SubmissionRecord {
  id: number
  contentId: number
  studentUserId: number
  studentFullName: string
  groupId: number | null
  file: ContentFile | null
  comment: string | null
  submittedAt: string
  grade: number | null
  feedback: string | null
  gradedAt: string | null
  gradedByUserId: number | null
  answers: number[] | null
  autoGraded: boolean
  attemptsUsed: number
  questionIds: number[] | null
  optionPerms: Record<number, number[]> | null
}

function parseOptionPerms(value: unknown): Record<number, number[]> | null {
  if (value == null) return null
  try {
    const obj: unknown = typeof value === "string" ? JSON.parse(value) : value
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const result: Record<number, number[]> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (Array.isArray(v)) result[Number(k)] = v.map(Number)
      }
      return result
    }
  } catch { /* ignore */ }
  return null
}

function mapSubmissionRow(row: mysql.RowDataPacket): SubmissionRecord {
  return {
    id: Number(row.id),
    contentId: Number(row.content_id),
    studentUserId: Number(row.student_user_id),
    studentFullName: String(row.student_full_name),
    groupId: row.group_id == null ? null : Number(row.group_id),
    file: row.file_name
      ? {
          name: String(row.file_name),
          originalName: String(row.original_name),
          mimeType: String(row.mime_type),
          size: Number(row.file_size),
          relativePath: String(row.relative_path),
          url: `/api/teaching/submissions/${Number(row.id)}/file`,
        }
      : null,
    comment: row.comment ?? null,
    submittedAt: fromMysqlDate(row.submitted_at),
    grade: row.grade == null ? null : Number(row.grade),
    feedback: row.feedback ?? null,
    gradedAt: row.graded_at ? fromMysqlDate(row.graded_at) : null,
    gradedByUserId: row.graded_by_user_id == null ? null : Number(row.graded_by_user_id),
    answers: parseAnswers(row.answers),
    autoGraded: Boolean(row.auto_graded),
    attemptsUsed: row.attempts_used == null ? 1 : Number(row.attempts_used),
    questionIds: parseAnswers(row.question_ids),
    optionPerms: parseOptionPerms(row.option_perms),
  }
}

function parseAnswers(value: unknown): number[] | null {
  if (value == null) return null
  if (Array.isArray(value)) return value.map((v) => Number(v))
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : null
    } catch {
      return null
    }
  }
  return null
}

export interface UpsertSubmissionInput {
  contentId: number
  studentUserId: number
  studentFullName: string
  groupId: number | null
  comment?: string | null
  file?: ContentFile | null
}

/** Talaba ishni (qayta) topshirganda yozadi — qayta topshirilsa, avvalgi baho tozalanadi. */
export async function upsertSubmission(input: UpsertSubmissionInput): Promise<SubmissionRecord> {
  await pool.query(
    `INSERT INTO lms_submissions
      (content_id, student_user_id, student_full_name, group_id,
       file_name, original_name, mime_type, file_size, relative_path, public_url, comment, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       student_full_name = VALUES(student_full_name),
       file_name         = VALUES(file_name),
       original_name     = VALUES(original_name),
       mime_type         = VALUES(mime_type),
       file_size         = VALUES(file_size),
       relative_path     = VALUES(relative_path),
       public_url        = VALUES(public_url),
       comment           = VALUES(comment),
       submitted_at      = CURRENT_TIMESTAMP,
       grade             = NULL,
       feedback          = NULL,
       graded_at         = NULL,
       graded_by_user_id = NULL`,
    [
      input.contentId,
      input.studentUserId,
      input.studentFullName,
      input.groupId,
      input.file?.name ?? null,
      input.file?.originalName ?? null,
      input.file?.mimeType ?? null,
      input.file?.size ?? null,
      input.file?.relativePath ?? null,
      input.file?.url ?? null,
      input.comment?.trim() || null,
    ]
  )
  const submission = await getSubmissionForStudent(input.contentId, input.studentUserId)
  if (!submission) throw new Error("Topshiriq saqlanmadi")
  return submission
}

export async function listSubmissions(contentId: number): Promise<SubmissionRecord[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_submissions WHERE content_id = ? ORDER BY submitted_at DESC",
    [contentId]
  )
  return rows.map(mapSubmissionRow)
}

export async function getSubmissionForStudent(contentId: number, studentUserId: number): Promise<SubmissionRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_submissions WHERE content_id = ? AND student_user_id = ?",
    [contentId, studentUserId]
  )
  return rows.length ? mapSubmissionRow(rows[0]) : null
}

export async function getSubmissionById(id: number): Promise<SubmissionRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM lms_submissions WHERE id = ?", [id])
  return rows.length ? mapSubmissionRow(rows[0]) : null
}

export async function gradeSubmission(
  id: number,
  gradedByUserId: number,
  grade: number,
  feedback?: string | null
): Promise<SubmissionRecord | null> {
  await pool.query(
    "UPDATE lms_submissions SET grade = ?, feedback = ?, graded_at = CURRENT_TIMESTAMP, graded_by_user_id = ? WHERE id = ?",
    [grade, feedback?.trim() || null, gradedByUserId, id]
  )
  return getSubmissionById(id)
}

/* ── Talaba progress: video/audio pozitsiyasi va hujjat sahifalari ──── */
export interface ContentProgress {
  contentId: number
  studentUserId: number
  maxPositionSeconds: number
  durationSeconds: number | null
  pagesRead: number[]
  totalPages: number | null
  completed: boolean
  completedAt: string | null
}

function mapProgressRow(row: mysql.RowDataPacket): ContentProgress {
  return {
    contentId: Number(row.content_id),
    studentUserId: Number(row.student_user_id),
    maxPositionSeconds: Number(row.max_position_seconds),
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    pagesRead: parsePagesRead(row.pages_read),
    totalPages: row.total_pages == null ? null : Number(row.total_pages),
    completed: Boolean(row.completed),
    completedAt: row.completed_at ? fromMysqlDate(row.completed_at) : null,
  }
}

function parsePagesRead(value: unknown): number[] {
  if (value == null) return []
  if (Array.isArray(value)) return value.map((v) => Number(v))
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((v) => Number(v)) : []
    } catch {
      return []
    }
  }
  return []
}

export async function getContentProgress(contentId: number, studentUserId: number): Promise<ContentProgress | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_content_progress WHERE content_id = ? AND student_user_id = ?",
    [contentId, studentUserId]
  )
  return rows.length ? mapProgressRow(rows[0]) : null
}

export interface UpsertContentProgressInput {
  contentId: number
  studentUserId: number
  positionSeconds?: number
  durationSeconds?: number
  pagesRead?: number[]
  totalPages?: number
  forceCompleted?: boolean
}

/** Talaba video/audio/hujjat ko'rish jarayonini yangilaydi — pozitsiya va sahifalar faqat ortib boradi. */
export async function upsertContentProgress(input: UpsertContentProgressInput): Promise<ContentProgress> {
  const existing = await getContentProgress(input.contentId, input.studentUserId)

  const maxPositionSeconds = Math.max(existing?.maxPositionSeconds ?? 0, input.positionSeconds ?? 0)
  const durationSeconds = input.durationSeconds ?? existing?.durationSeconds ?? null
  const totalPages = input.totalPages ?? existing?.totalPages ?? null
  const pagesRead = Array.from(new Set([...(existing?.pagesRead ?? []), ...(input.pagesRead ?? [])])).sort((a, b) => a - b)

  let completed = existing?.completed ?? false
  if (input.forceCompleted) {
    completed = true
  } else if (durationSeconds != null) {
    completed = maxPositionSeconds >= durationSeconds - 2
  } else if (totalPages != null) {
    completed = pagesRead.length >= totalPages
  }

  await pool.query(
    `INSERT INTO lms_content_progress
      (content_id, student_user_id, max_position_seconds, duration_seconds, pages_read, total_pages, completed, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       max_position_seconds = VALUES(max_position_seconds),
       duration_seconds     = VALUES(duration_seconds),
       pages_read           = VALUES(pages_read),
       total_pages          = VALUES(total_pages),
       completed            = VALUES(completed),
       completed_at         = VALUES(completed_at)`,
    [
      input.contentId,
      input.studentUserId,
      maxPositionSeconds,
      durationSeconds,
      pagesRead.length ? JSON.stringify(pagesRead) : null,
      totalPages,
      completed ? 1 : 0,
      completed && !existing?.completed ? new Date() : existing?.completedAt ? toMysqlDate(new Date(existing.completedAt)) : null,
    ]
  )

  const result = await getContentProgress(input.contentId, input.studentUserId)
  if (!result) throw new Error("Progress saqlanmadi")
  return result
}

/* ── Jurnal uchun bulk so'rovlar ─────────────────────────────────────── */
export async function getProgressBulk(
  contentIds: number[],
  studentIds: number[]
): Promise<{ contentId: number; studentUserId: number; completed: boolean }[]> {
  if (!contentIds.length || !studentIds.length) return []
  const ph = (arr: number[]) => arr.map(() => "?").join(",")
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT content_id, student_user_id, completed FROM lms_content_progress
     WHERE content_id IN (${ph(contentIds)}) AND student_user_id IN (${ph(studentIds)})`,
    [...contentIds, ...studentIds]
  )
  return rows.map(r => ({
    contentId: Number(r.content_id),
    studentUserId: Number(r.student_user_id),
    completed: Boolean(r.completed),
  }))
}

export async function getSubmissionsBulk(
  contentIds: number[],
  studentIds: number[]
): Promise<{ contentId: number; studentUserId: number; grade: number | null }[]> {
  if (!contentIds.length || !studentIds.length) return []
  const ph = (arr: number[]) => arr.map(() => "?").join(",")
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT content_id, student_user_id, grade FROM lms_submissions
     WHERE content_id IN (${ph(contentIds)}) AND student_user_id IN (${ph(studentIds)})`,
    [...contentIds, ...studentIds]
  )
  return rows.map(r => ({
    contentId: Number(r.content_id),
    studentUserId: Number(r.student_user_id),
    grade: r.grade !== null && r.grade !== undefined ? Number(r.grade) : null,
  }))
}

/* ── Davriy baholar (ON, YN) ─────────────────────────────────────────── */
export async function getPeriodGrades(
  groupId: number,
  subjectName: string
): Promise<{ studentUserId: number; gradeType: string; grade: number | null }[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT student_user_id, grade_type, grade FROM lms_period_grades
     WHERE group_id = ? AND LOWER(subject_name) = LOWER(?)`,
    [groupId, subjectName]
  )
  return rows.map(r => ({
    studentUserId: Number(r.student_user_id),
    gradeType: String(r.grade_type),
    grade: r.grade !== null && r.grade !== undefined ? Number(r.grade) : null,
  }))
}

export async function upsertPeriodGrade(
  groupId: number,
  subjectName: string,
  studentUserId: number,
  gradeType: string,
  grade: number | null,
  teacherUserId: number
): Promise<void> {
  await pool.query(
    `INSERT INTO lms_period_grades (group_id, subject_name, student_user_id, grade_type, grade, teacher_user_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE grade = VALUES(grade), teacher_user_id = VALUES(teacher_user_id), updated_at = CURRENT_TIMESTAMP`,
    [groupId, subjectName, studentUserId, gradeType, grade, teacherUserId]
  )
}
