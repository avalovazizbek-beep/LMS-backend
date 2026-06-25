import fs from "fs"
import path from "path"
import jwt from "jsonwebtoken"
import type mysql from "mysql2/promise"
import { fromMysqlDate, pool, toMysqlDate } from "./db"
import { sanitizeFilename } from "./teachingStore"

export type MeetingRole = "admin" | "teacher" | "student"
export type MeetingStatus = "scheduled" | "live" | "ended" | "cancelled"

export interface MeetingSettings {
  allowCamera: boolean
  allowMicrophone: boolean
  allowScreenShare: boolean
  allowChat: boolean
}

export interface MeetingPermissions extends MeetingSettings {
  canManageMeeting: boolean
}

export interface MeetingUser {
  id: number
  fullName: string
  role: MeetingRole
  groupId: number | null
  teacherGroupIds: number[]
}

export interface MeetingRecord {
  id: number
  title: string
  description: string | null
  subjectName: string | null
  createdByUserId: number
  startTime: string
  endTime: string
  status: MeetingStatus
  groupIds: number[]
  groupNames: string[]
  settings: MeetingSettings
}

export interface MeetingResponse extends MeetingRecord {
  permissions: MeetingPermissions
  canJoinNow: boolean
}

export interface AttendanceSession {
  sessionId: number
  joinedAt: string | null
  leftAt: string | null
  totalSeconds: number
  totalMinutes: number
  totalDurationLabel: string
  status: "live" | "left"
}

export interface AttendanceSummary {
  attendanceId: number
  meetingId: number
  userId: number
  groupId: number | null
  fullName: string
  firstJoinedAt: string | null
  lastLeftAt: string | null
  totalSeconds: number
  totalMinutes: number
  totalDurationLabel: string
  sessionCount: number
  currentlyInMeeting: boolean
  isPresent: boolean
  syncedToMainBackend: boolean
  sessions: AttendanceSession[]
}

export interface AuthLikeUser {
  id?: string | number
  userId?: string | number
  username?: string
  fullName?: string
  role?: string
  groupId?: string | number | null
  teacherGroupIds?: Array<string | number>
}

export interface CreateMeetingInput {
  title: string
  description?: string | null
  subjectName?: string | null
  startTime: string
  endTime: string
  groupIds: Array<number | string>
  settings?: Partial<MeetingSettings>
}

const JWT_SECRET = process.env.MEETING_JWT_SECRET || process.env.JWT_SECRET || "secret"

const defaultSettings: MeetingSettings = {
  allowCamera: true,
  allowMicrophone: true,
  allowScreenShare: false,
  allowChat: true,
}


/* ── Helpers ───────────────────────────────────────────────────────── */
export function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function stableNumericId(value: unknown, fallback: number) {
  const direct = parseNumber(value)
  if (direct !== null) return direct
  const text = String(value ?? "")
  if (!text) return fallback
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash || fallback
}

function normalizeRole(role?: string): MeetingRole {
  if (role === "teacher" || role === "employee") return "teacher"
  if (role === "student") return "student"
  return "admin"
}

function normalizeSettings(value: unknown): MeetingSettings {
  let parsed: Partial<MeetingSettings> = {}
  if (typeof value === "string" && value.trim()) {
    try { parsed = JSON.parse(value) } catch { parsed = {} }
  } else if (value && typeof value === "object") {
    parsed = value as Partial<MeetingSettings>
  }
  return { ...defaultSettings, ...parsed }
}

function secondsBetween(startIso: string | null, endIso: string | null) {
  if (!startIso) return 0
  const start = new Date(startIso).getTime()
  const end   = endIso ? new Date(endIso).getTime() : Date.now()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0
  return Math.floor((end - start) / 1000)
}

function durationLabel(totalSeconds: number) {
  const hours   = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, "0")).join(":")
}

/* ── DB helpers ────────────────────────────────────────────────────── */
async function teacherGroupIds(userId: number): Promise<number[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT group_id FROM lms_teacher_groups WHERE user_id = ? ORDER BY group_id", [userId]
  )
  return rows.map(r => Number(r.group_id))
}

async function meetingGroupIds(meetingId: number): Promise<number[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT group_id FROM lms_meeting_groups WHERE meeting_id = ? ORDER BY group_id", [meetingId]
  )
  return rows.map(r => Number(r.group_id))
}

async function meetingGroupNames(meetingId: number): Promise<string[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT mg.group_id, g.name FROM lms_meeting_groups mg
     LEFT JOIN lms_groups g ON g.id = mg.group_id
     WHERE mg.meeting_id = ? ORDER BY COALESCE(g.name, mg.group_id)`,
    [meetingId]
  )
  return rows.map(r => r.name ? String(r.name) : `Guruh ${r.group_id}`)
}

async function mapMeeting(row: mysql.RowDataPacket): Promise<MeetingRecord> {
  const id = Number(row.id)
  const [gids, gnames] = await Promise.all([meetingGroupIds(id), meetingGroupNames(id)])
  return {
    id,
    title:           String(row.title),
    description:     row.description ?? null,
    subjectName:     row.subject_name ?? null,
    createdByUserId: Number(row.created_by_user_id),
    startTime:       fromMysqlDate(row.start_time),
    endTime:         fromMysqlDate(row.end_time),
    status:          row.status as MeetingStatus,
    groupIds:        gids,
    groupNames:      gnames,
    settings:        normalizeSettings(row.settings_json),
  }
}

function mapUser(row: mysql.RowDataPacket, groups: number[]): MeetingUser {
  return {
    id:             Number(row.id),
    fullName:       String(row.full_name),
    role:           normalizeRole(row.role),
    groupId:        row.group_id == null ? null : Number(row.group_id),
    teacherGroupIds: groups,
  }
}

/* ── Users ─────────────────────────────────────────────────────────── */
export async function resolveMeetingUser(authUser?: AuthLikeUser): Promise<MeetingUser> {
  const role    = normalizeRole(authUser?.role)
  const directId = authUser?.userId ?? authUser?.id
  const id      = stableNumericId(directId, role === "student" ? 9101 : 9001)

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_meeting_users WHERE id = ? LIMIT 1", [id]
  )
  if (rows.length) {
    if (rows[0].role === "teacher") {
      const freshGroups = authUser?.teacherGroupIds
        ?.map(item => parseNumber(item))
        .filter((item): item is number => item !== null) ?? []
      for (const gid of freshGroups) {
        await pool.query(
          "INSERT IGNORE INTO lms_teacher_groups (user_id, group_id) VALUES (?, ?)", [id, gid]
        )
      }
      return mapUser(rows[0], await teacherGroupIds(id))
    }
    return mapUser(rows[0], [])
  }

  const groupId = parseNumber(authUser?.groupId) ?? (role === "student" ? 501 : null)
  const teacherGroups =
    authUser?.teacherGroupIds
      ?.map(item => parseNumber(item))
      .filter((item): item is number => item !== null) ?? (role === "teacher" ? [501, 502] : [])
  const fullName = authUser?.fullName || authUser?.username || "LMS User"

  await pool.query(
    "INSERT IGNORE INTO lms_meeting_users (id, full_name, role, group_id) VALUES (?, ?, ?, ?)",
    [id, fullName, role, groupId]
  )
  for (const gid of teacherGroups) {
    await pool.query(
      "INSERT IGNORE INTO lms_teacher_groups (user_id, group_id) VALUES (?, ?)", [id, gid]
    )
  }

  return { id, fullName, role, groupId, teacherGroupIds: teacherGroups }
}

/* ── Tokens ────────────────────────────────────────────────────────── */
export function signAccessToken(user: MeetingUser) {
  return jwt.sign(
    { id: user.id, userId: user.id, username: user.fullName, fullName: user.fullName,
      role: user.role, groupId: user.groupId, teacherGroupIds: user.teacherGroupIds },
    JWT_SECRET, { expiresIn: "7d" }
  )
}

export function signJoinToken(meeting: MeetingRecord, user: MeetingUser) {
  return jwt.sign(
    { type: "meeting-join", meetingId: meeting.id, userId: user.id,
      fullName: user.fullName, role: user.role, groupId: user.groupId },
    JWT_SECRET, { expiresIn: "5m" }
  )
}

export function verifyJoinToken(token: string) {
  return jwt.verify(token, JWT_SECRET) as {
    type: "meeting-join"; meetingId: number; userId: number
    fullName: string; role: MeetingRole; groupId: number | null
  }
}

/* ── Permissions ───────────────────────────────────────────────────── */
export function canManageMeeting(user: MeetingUser, meeting?: MeetingRecord) {
  if (user.role === "admin") return true
  if (user.role !== "teacher") return false
  if (!meeting) return true
  if (meeting.createdByUserId === user.id) return true
  return meeting.groupIds.some(gid => user.teacherGroupIds.includes(gid))
}

export function canViewMeeting(user: MeetingUser, meeting: MeetingRecord) {
  if (canManageMeeting(user, meeting)) return true
  if (user.role !== "student" || user.groupId === null) return false
  return meeting.groupIds.includes(user.groupId)
}

export function getPermissions(user: MeetingUser, meeting: MeetingRecord): MeetingPermissions {
  const canManage = canManageMeeting(user, meeting)
  return {
    allowCamera:      meeting.settings.allowCamera,
    allowMicrophone:  meeting.settings.allowMicrophone,
    allowScreenShare: meeting.settings.allowScreenShare || canManage,
    allowChat:        meeting.settings.allowChat,
    canManageMeeting: canManage,
  }
}

export function canJoinNow(meeting: MeetingRecord) {
  const start   = new Date(meeting.startTime).getTime()
  const end     = new Date(meeting.endTime).getTime()
  const current = Date.now()
  return meeting.status === "live" || (meeting.status === "scheduled" && current >= start && current <= end)
}

export function toMeetingResponse(meeting: MeetingRecord, user: MeetingUser): MeetingResponse {
  return { ...meeting, permissions: getPermissions(user, meeting), canJoinNow: canJoinNow(meeting) }
}

/* ── CRUD ──────────────────────────────────────────────────────────── */
export async function listMeetingsForUser(user: MeetingUser): Promise<MeetingRecord[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_meetings WHERE status <> 'cancelled' ORDER BY start_time DESC"
  )
  const meetings: MeetingRecord[] = []
  for (const row of rows) {
    const meeting = await mapMeeting(row)
    if (canViewMeeting(user, meeting)) meetings.push(meeting)
  }
  return meetings
}

export async function getMeeting(id: number): Promise<MeetingRecord | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_meetings WHERE id = ? LIMIT 1", [id]
  )
  return rows.length ? mapMeeting(rows[0]) : null
}

export async function createMeeting(input: CreateMeetingInput, user: MeetingUser): Promise<MeetingRecord> {
  const groupIds = input.groupIds.map(parseNumber).filter((n): n is number => n !== null)
  const settings = { ...defaultSettings, ...(input.settings ?? {}) }
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO lms_meetings (title, description, subject_name, created_by_user_id, start_time, end_time, status, settings_json)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
    [
      input.title.trim(),
      input.description?.trim() || null,
      input.subjectName?.trim() || null,
      user.id,
      toMysqlDate(new Date(input.startTime)),
      toMysqlDate(new Date(input.endTime)),
      JSON.stringify(settings),
    ]
  )
  for (const gid of groupIds) {
    await pool.query("INSERT INTO lms_meeting_groups (meeting_id, group_id) VALUES (?, ?)", [result.insertId, gid])
  }
  const meeting = await getMeeting(result.insertId)
  if (!meeting) throw new Error("Meeting saqlanmadi")
  return meeting
}

export async function startMeeting(meeting: MeetingRecord): Promise<MeetingRecord> {
  if (meeting.status !== "ended" && meeting.status !== "cancelled") {
    await pool.query("UPDATE lms_meetings SET status = 'live' WHERE id = ?", [meeting.id])
    meeting.status = "live"
  }
  return meeting
}

export async function endMeeting(meeting: MeetingRecord): Promise<MeetingRecord> {
  await pool.query("UPDATE lms_meetings SET status = 'ended' WHERE id = ?", [meeting.id])
  await pool.query(
    `UPDATE lms_meeting_attendance_sessions s
     JOIN lms_meeting_attendance a ON a.id = s.attendance_id
     SET s.left_at = NOW()
     WHERE a.meeting_id = ? AND s.left_at IS NULL`,
    [meeting.id]
  )
  meeting.status = "ended"

  // Kirgan talabalarni lms_attendance ga avtomatik ko'chirish
  await syncMeetingAttendanceToMain(meeting)

  return meeting
}

/** Meeting tugaganda barcha kirgan talabalarni (group_id bor) lms_attendance ga yozadi */
async function syncMeetingAttendanceToMain(meeting: MeetingRecord): Promise<void> {
  if (!meeting.subjectName) return

  const lessonDate = new Date(meeting.startTime).toISOString().slice(0, 10)
  const subjectName = meeting.subjectName

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT user_id, group_id, full_name
     FROM lms_meeting_attendance
     WHERE meeting_id = ? AND group_id IS NOT NULL`,
    [meeting.id]
  )

  for (const row of rows) {
    await pool.query(
      `INSERT INTO lms_attendance
         (group_id, subject_name, lesson_date, student_user_id, student_full_name,
          status, comment, marked_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'present', 'Meeting orqali avtomatik', 0)
       ON DUPLICATE KEY UPDATE
         status            = 'present',
         student_full_name = VALUES(student_full_name)`,
      [Number(row.group_id), subjectName, lessonDate, Number(row.user_id), String(row.full_name)]
    )
  }

  if (rows.length) {
    await pool.query(
      "UPDATE lms_meeting_attendance SET synced_to_main_backend = TRUE WHERE meeting_id = ? AND group_id IS NOT NULL",
      [meeting.id]
    )
  }
}

export async function joinMeeting(meeting: MeetingRecord, user: MeetingUser): Promise<AttendanceSummary | null> {
  await pool.query(
    `INSERT INTO lms_meeting_attendance (meeting_id, user_id, group_id, full_name)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), group_id = VALUES(group_id)`,
    [meeting.id, user.id, user.groupId, user.fullName]
  )
  const [attRows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT id FROM lms_meeting_attendance WHERE meeting_id = ? AND user_id = ? LIMIT 1",
    [meeting.id, user.id]
  )
  const attendanceId = Number(attRows[0].id)
  const [liveRows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT id FROM lms_meeting_attendance_sessions WHERE attendance_id = ? AND left_at IS NULL LIMIT 1",
    [attendanceId]
  )
  if (!liveRows.length) {
    await pool.query(
      "INSERT INTO lms_meeting_attendance_sessions (attendance_id, joined_at) VALUES (?, NOW())", [attendanceId]
    )
  }

  // Talaba online darsga kirsa lms_attendance ga "keldi" deb yoz
  if (user.role === "student" && user.groupId && meeting.subjectName?.trim()) {
    try {
      const today = new Date().toISOString().slice(0, 10)
      await pool.query(
        `INSERT INTO lms_attendance
           (group_id, subject_name, lesson_date, student_user_id, student_full_name, status, comment, marked_by_user_id)
         VALUES (?, ?, ?, ?, ?, 'present', 'Online dars', ?)
         ON DUPLICATE KEY UPDATE status = 'present', comment = COALESCE(comment, 'Online dars')`,
        [user.groupId, meeting.subjectName.trim(), today, user.id, user.fullName ?? `Talaba #${user.id}`, meeting.createdByUserId]
      )
    } catch { /* ignore — main functionality not affected */ }
  }

  const summaries = await getAttendance(meeting.id)
  return summaries.find(s => s.userId === user.id) ?? null
}

export async function leaveMeeting(meetingId: number, userId: number): Promise<AttendanceSummary | null> {
  await pool.query(
    `UPDATE lms_meeting_attendance_sessions s
     JOIN lms_meeting_attendance a ON a.id = s.attendance_id
     SET s.left_at = NOW()
     WHERE a.meeting_id = ? AND a.user_id = ? AND s.left_at IS NULL`,
    [meetingId, userId]
  )
  const summaries = await getAttendance(meetingId)
  return summaries.find(s => s.userId === userId) ?? null
}

export async function getAttendance(meetingId: number): Promise<AttendanceSummary[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
       a.id attendance_id, a.meeting_id, a.user_id, a.group_id, a.full_name, a.synced_to_main_backend,
       s.id session_id, s.joined_at, s.left_at
     FROM lms_meeting_attendance a
     LEFT JOIN lms_meeting_attendance_sessions s ON s.attendance_id = a.id
     WHERE a.meeting_id = ?
     ORDER BY a.id, s.id`,
    [meetingId]
  )

  const map = new Map<number, AttendanceSummary>()
  for (const row of rows) {
    const attendanceId = Number(row.attendance_id)
    if (!map.has(attendanceId)) {
      map.set(attendanceId, {
        attendanceId, meetingId: Number(row.meeting_id), userId: Number(row.user_id),
        groupId: row.group_id == null ? null : Number(row.group_id),
        fullName: String(row.full_name), firstJoinedAt: null, lastLeftAt: null,
        totalSeconds: 0, totalMinutes: 0, totalDurationLabel: "00:00:00",
        sessionCount: 0, currentlyInMeeting: false, isPresent: false,
        syncedToMainBackend: Boolean(row.synced_to_main_backend), sessions: [],
      })
    }
    if (row.session_id == null) continue
    const joinedAt = row.joined_at ? fromMysqlDate(row.joined_at) : null
    const leftAt   = row.left_at  ? fromMysqlDate(row.left_at)   : null
    const totalSeconds = secondsBetween(joinedAt, leftAt)
    map.get(attendanceId)!.sessions.push({
      sessionId: Number(row.session_id), joinedAt, leftAt, totalSeconds,
      totalMinutes: Math.ceil(totalSeconds / 60),
      totalDurationLabel: durationLabel(totalSeconds),
      status: leftAt ? "left" : "live",
    })
  }

  return Array.from(map.values()).map(summary => {
    const totalSeconds = summary.sessions.reduce((sum, s) => sum + s.totalSeconds, 0)
    summary.firstJoinedAt    = summary.sessions.map(s => s.joinedAt).filter(Boolean).sort()[0] ?? null
    summary.lastLeftAt       = summary.sessions.map(s => s.leftAt).filter(Boolean).sort().at(-1) ?? null
    summary.totalSeconds     = totalSeconds
    summary.totalMinutes     = Math.ceil(totalSeconds / 60)
    summary.totalDurationLabel = durationLabel(totalSeconds)
    summary.sessionCount     = summary.sessions.length
    summary.currentlyInMeeting = summary.sessions.some(s => !s.leftAt)
    summary.isPresent        = totalSeconds > 0 || summary.currentlyInMeeting
    return summary
  })
}

export async function deleteMeeting(id: number): Promise<void> {
  await pool.query("DELETE FROM lms_meetings WHERE id = ?", [id])
}

export async function markAttendanceSynced(): Promise<number> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    "UPDATE lms_meeting_attendance SET synced_to_main_backend = TRUE WHERE synced_to_main_backend = FALSE"
  )
  return result.affectedRows
}

/* ── Recordings ────────────────────────────────────────────────────── */
const STORAGE_ROOT = path.resolve(process.env.LOCAL_RESOURCE_STORAGE || path.join(process.cwd(), "storage"))
const RECORDINGS_ROOT = path.join(STORAGE_ROOT, "private", "recordings")

function recordingsUploadsDir() {
  fs.mkdirSync(RECORDINGS_ROOT, { recursive: true })
  return RECORDINGS_ROOT
}

function recordingsStorageRoot() {
  return path.join(STORAGE_ROOT, "private")
}

export interface MeetingRecording {
  id: number
  meetingId: number
  title: string
  subjectName: string | null
  groupIds: number[]
  startTime: string
  originalName: string
  mimeType: string
  fileSize: number
  createdAt: string
}

interface RecordingFileInput {
  name: string
  originalName: string
  mimeType: string
  size: number
  relativePath: string
}

async function mapRecording(row: mysql.RowDataPacket): Promise<MeetingRecording> {
  return {
    id:           Number(row.id),
    meetingId:    Number(row.meeting_id),
    title:        String(row.title),
    subjectName:  row.subject_name ?? null,
    groupIds:     await meetingGroupIds(Number(row.meeting_id)),
    startTime:    fromMysqlDate(row.start_time),
    originalName: String(row.original_name),
    mimeType:     String(row.mime_type),
    fileSize:     Number(row.file_size),
    createdAt:    fromMysqlDate(row.created_at),
  }
}

export async function addRecording(
  meetingId: number,
  recordedByUserId: number,
  file: RecordingFileInput
): Promise<MeetingRecording> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `INSERT INTO lms_meeting_recordings
       (meeting_id, file_name, original_name, mime_type, file_size, relative_path, recorded_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [meetingId, file.name, file.originalName, file.mimeType, file.size, file.relativePath, recordedByUserId]
  )
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT r.*, m.title, m.subject_name, m.start_time
     FROM lms_meeting_recordings r
     JOIN lms_meetings m ON m.id = r.meeting_id
     WHERE r.id = ? LIMIT 1`,
    [result.insertId]
  )
  return mapRecording(rows[0])
}

export async function listRecordingsForMeeting(meetingId: number): Promise<MeetingRecording[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT r.*, m.title, m.subject_name, m.start_time
     FROM lms_meeting_recordings r
     JOIN lms_meetings m ON m.id = r.meeting_id
     WHERE r.meeting_id = ?
     ORDER BY r.created_at DESC`,
    [meetingId]
  )
  return Promise.all(rows.map(mapRecording))
}

export async function getRecordingWithMeeting(id: number): Promise<{
  recording: MeetingRecording
  meeting: MeetingRecord
  relativePath: string
  originalName: string
  mimeType: string
} | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT r.*, m.title, m.subject_name, m.start_time
     FROM lms_meeting_recordings r
     JOIN lms_meetings m ON m.id = r.meeting_id
     WHERE r.id = ? LIMIT 1`,
    [id]
  )
  if (!rows.length) return null
  const meeting = await getMeeting(Number(rows[0].meeting_id))
  if (!meeting) return null
  return {
    recording:    await mapRecording(rows[0]),
    meeting,
    relativePath: String(rows[0].relative_path),
    originalName: String(rows[0].original_name),
    mimeType:     String(rows[0].mime_type),
  }
}

export async function listRecordingsForUser(user: MeetingUser): Promise<MeetingRecording[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT r.*, m.title, m.subject_name, m.start_time
     FROM lms_meeting_recordings r
     JOIN lms_meetings m ON m.id = r.meeting_id
     ORDER BY r.created_at DESC`
  )
  const recordings: MeetingRecording[] = []
  for (const row of rows) {
    const meeting = await getMeeting(Number(row.meeting_id))
    if (!meeting) continue
    if (!canViewMeeting(user, meeting)) continue
    recordings.push(await mapRecording(row))
  }
  return recordings
}

export { recordingsUploadsDir, recordingsStorageRoot }
