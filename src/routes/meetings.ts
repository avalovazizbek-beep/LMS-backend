import fs from "fs"
import path from "path"
import jwt from "jsonwebtoken"
import { Router, Response } from "express"
import type { Server as SocketIOServer } from "socket.io"
import type { ResultSetHeader, RowDataPacket } from "mysql2"
import { authMiddleware, AuthRequest, AuthUser } from "../middleware/auth"

let _io: SocketIOServer | null = null
export function setSocketIO(io: SocketIOServer) { _io = io }
import { sanitizeFilename } from "../services/teachingStore"
import { pool } from "../services/db"
import { randomUUID } from "crypto"
import {
  addRecording,
  canManageMeeting,
  canViewMeeting,
  createMeeting,
  deleteMeeting,
  endMeeting,
  getAttendance,
  getMeeting,
  getRecordingWithMeeting,
  joinMeeting,
  recordFacePresence,
  listMeetingsForUser,
  listRecordingsForMeeting,
  listRecordingsForUser,
  recordingsStorageRoot,
  recordingsUploadsDir,
  resolveMeetingUser,
  signJoinToken,
  startMeeting,
  toMeetingResponse,
  type CreateMeetingInput,
} from "../services/meetingStore"

const JWT_SECRET = process.env.JWT_SECRET || "secret"
const MAX_UPLOAD_BYTES = Number(process.env.LOCAL_RESOURCE_MAX_BYTES || 2 * 1024 * 1024 * 1024)

const router = Router()

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function meetingId(req: AuthRequest) {
  const id = Number(req.params.id)
  return Number.isFinite(id) ? id : null
}

/* ── token-tekshiruvchi fayl oqimi (authMiddleware'dan OLDIN) ──────────
   <video src="...?token=..."> to'g'ridan-to'g'ri brauzerdan ochilishi
   uchun, teaching.ts:userFromRequest naqshiga o'xshab. */
function userFromRequest(req: AuthRequest): AuthUser | null {
  if (req.user) return req.user
  const headerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.split(" ")[1]
    : null
  const queryToken = textValue(req.query.token)
  const token = headerToken || queryToken
  if (!token) return null
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser
  } catch {
    return null
  }
}

router.get("/recordings/:id/file", async (req: AuthRequest, res: Response): Promise<void> => {
  const authUser = userFromRequest(req)
  if (!authUser) {
    res.status(401).json({ success: false, message: "Token topilmadi yoki yaroqsiz" })
    return
  }
  const id = Number(req.params.id)
  const found = Number.isFinite(id) ? await getRecordingWithMeeting(id) : null
  if (!found) {
    res.status(404).json({ success: false, message: "Yozuv topilmadi" })
    return
  }
  const user = await resolveMeetingUser(authUser)
  if (!canViewMeeting(user, found.meeting)) {
    res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
    return
  }

  const absolutePath = path.join(recordingsStorageRoot(), found.relativePath.replace(/^\/+/, ""))
  if (!fs.existsSync(absolutePath)) {
    res.status(404).json({ success: false, message: "Fayl topilmadi" })
    return
  }
  res.setHeader("Content-Type", found.mimeType || "video/webm")
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(found.originalName)}"`)
  fs.createReadStream(absolutePath).pipe(res)
})

router.use(authMiddleware)

async function groupedMeetings(req: AuthRequest) {
  const user = await resolveMeetingUser(req.user)
  const meetings = (await listMeetingsForUser(user)).map((meeting) =>
    toMeetingResponse(meeting, user)
  )

  return {
    upcoming: meetings.filter(
      (meeting) => meeting.status === "scheduled" || meeting.status === "live"
    ),
    past: meetings.filter(
      (meeting) => meeting.status === "ended" || meeting.status === "cancelled"
    ),
  }
}

function validateCreateBody(body: Partial<CreateMeetingInput>) {
  if (!body.title?.trim()) return "title majburiy"
  if (!body.startTime) return "startTime majburiy"
  if (!body.endTime) return "endTime majburiy"
  if (!Array.isArray(body.groupIds) || body.groupIds.length === 0) {
    return "groupIds majburiy"
  }
  if (Number.isNaN(new Date(body.startTime).getTime())) {
    return "startTime noto'g'ri"
  }
  if (Number.isNaN(new Date(body.endTime).getTime())) {
    return "endTime noto'g'ri"
  }
  if (new Date(body.endTime).getTime() <= new Date(body.startTime).getTime()) {
    return "endTime startTime dan keyin bo'lishi kerak"
  }
  return null
}

router.get("/", async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: await groupedMeetings(req) })
})

router.get("/my", async (req: AuthRequest, res: Response) => {
  res.json({ success: true, data: await groupedMeetings(req) })
})

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await resolveMeetingUser(req.user)
  if (!canManageMeeting(user)) {
    res.status(403).json({ success: false, message: "Meeting yaratishga ruxsat yo'q" })
    return
  }

  const error = validateCreateBody(req.body)
  if (error) {
    res.status(400).json({ success: false, message: error })
    return
  }

  const meeting = await createMeeting(
    { ...req.body, subjectName: textValue(req.body.subjectName) || null },
    user
  )
  res.status(201).json({ success: true, data: toMeetingResponse(meeting, user) })
})

router.get("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canViewMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Meetingni ko'rishga ruxsat yo'q" })
    return
  }

  res.json({ success: true, data: toMeetingResponse(meeting, user) })
})

router.post("/:id/start", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canManageMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Meetingni boshlashga ruxsat yo'q" })
    return
  }

  res.json({ success: true, data: toMeetingResponse(await startMeeting(meeting), user) })
})

router.post("/:id/end", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canManageMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Meetingni yakunlashga ruxsat yo'q" })
    return
  }

  const ended = await endMeeting(meeting)
  _io?.to(`meeting:${meeting.id}`).emit("meeting:ended", { meetingId: meeting.id })

  // Auto-save ended meeting as a subject resource if it has a subject
  if (meeting.subjectName) {
    try {
      const teacherName = typeof user?.fullName === "string" ? user.fullName : ""

      // Check if there are already uploaded recordings for this meeting
      const [recRows] = await pool.query<RowDataPacket[]>(
        `SELECT id, file_name, original_name, mime_type, file_size, relative_path
         FROM lms_meeting_recordings WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1`,
        [meeting.id]
      )
      const rec = recRows[0]
      const recUrl   = rec ? `/api/meetings/recordings/${rec.id}/file` : ""
      const fileName = rec ? String(rec.file_name)     : ""
      const origName = rec ? String(rec.original_name) : ""
      const mime     = rec ? String(rec.mime_type)     : "video/webm"
      const size     = rec ? Number(rec.file_size)     : 0
      const relPath  = rec ? String(rec.relative_path) : ""

      // Check if a resource entry already exists for this meeting (e.g. recording was uploaded before end)
      const [existRows] = await pool.query<RowDataPacket[]>(
        "SELECT uuid FROM lms_subject_resources WHERE meeting_id = ? LIMIT 1",
        [meeting.id]
      )

      if (existRows.length > 0) {
        // Update existing entry (created when recording was uploaded)
        if (rec) {
          await pool.query(
            `UPDATE lms_subject_resources
             SET file_name=?, original_name=?, mime_type=?, file_size=?, relative_path=?, public_url=?,
                 title=?, employee_name=?
             WHERE meeting_id=?`,
            [fileName, origName, mime, size, relPath, recUrl, meeting.title, teacherName, meeting.id]
          )
        }
      } else {
        // Create new entry (may have recording already or just a placeholder)
        await pool.query(
          `INSERT IGNORE INTO lms_subject_resources
             (uuid, subject_name, title, comment, kind, training_type_name, employee_name, meeting_id,
              file_name, original_name, mime_type, file_size, relative_path, public_url, external_url)
           VALUES (?, ?, ?, ?, 'meeting_video', 'Online dars', ?, ?,
                   ?, ?, ?, ?, ?, ?, NULL)`,
          [
            randomUUID(), meeting.subjectName, meeting.title, meeting.description ?? null,
            teacherName, meeting.id,
            fileName, origName, mime, size, relPath, recUrl
          ]
        )
      }
    } catch { /* e'tiborsiz qoldirish — asosiy natijaga ta'sir qilmasin */ }
  }

  res.json({ success: true, data: toMeetingResponse(ended, user) })
})

router.post("/:id/join-token", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canViewMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Meetingga kirishga ruxsat yo'q" })
    return
  }
  if (meeting.status === "ended" || meeting.status === "cancelled") {
    res.status(409).json({ success: false, message: "Meeting yakunlangan" })
    return
  }

  const permissions = toMeetingResponse(meeting, user).permissions
  await joinMeeting(meeting, user)

  res.json({
    success: true,
    data: {
      token: signJoinToken(meeting, user),
      meeting: toMeetingResponse(meeting, user),
      permissions,
      expiresIn: "5m",
      socketUrl: process.env.MEETING_SOCKET_URL || `http://localhost:${process.env.PORT || 5000}`,
    },
  })
})

/* Talaba meeting davomida face-api.js orqali har necha soniyada
   kamerada yuzi ko'ringan-ko'rinmaganini shu yerga yuboradi. Davomat
   holati bunga qarab meeting tugaganda hisoblanadi (syncMeetingAttendanceToMain). */
router.post("/:id/face-ping", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (meeting.status !== "live") {
    res.status(409).json({ success: false, message: "Meeting faol emas" })
    return
  }

  const visible = Boolean(req.body?.visible)
  const intervalSeconds = Number(req.body?.intervalSeconds) || 15
  await recordFacePresence(meeting.id, user.id, visible, intervalSeconds)

  res.json({ success: true })
})

router.get("/:id/attendance", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canManageMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Davomatni ko'rishga ruxsat yo'q" })
    return
  }

  res.json({ success: true, data: await getAttendance(meeting.id) })
})

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }

  const isCreator = meeting.createdByUserId === user.id
  const isAdmin   = user.role === "admin"

  if (!isCreator && !isAdmin) {
    res.status(403).json({ success: false, message: "Faqat yaratuvchi yoki admin o'chira oladi" })
    return
  }

  await deleteMeeting(meeting.id)
  res.json({ success: true, message: "Meeting o'chirildi" })
})

router.patch("/:id/done", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canManageMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Meetingni yakunlashga ruxsat yo'q" })
    return
  }

  const done = await endMeeting(meeting)
  _io?.to(`meeting:${meeting.id}`).emit("meeting:ended", { meetingId: meeting.id })
  res.json({ success: true, data: toMeetingResponse(done, user) })
})

/* ── Yozuvlar (recordings) ───────────────────────────────────────────── */
const ALLOWED_RECORDING_EXTENSIONS = new Set([".webm", ".mp4", ".mkv", ".ogg"])

router.get("/recordings/mine", async (req: AuthRequest, res: Response) => {
  const user = await resolveMeetingUser(req.user)
  res.json({ success: true, data: await listRecordingsForUser(user) })
})

router.get("/recordings/by-subject", async (req: AuthRequest, res: Response) => {
  const user = await resolveMeetingUser(req.user)
  const subject = typeof req.query.subject === "string" ? req.query.subject.trim() : ""
  if (!subject) {
    res.json({ success: true, data: [] }); return
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT r.*, m.title, m.subject_name, m.start_time
     FROM lms_meeting_recordings r
     JOIN lms_meetings m ON m.id = r.meeting_id
     WHERE LOWER(m.subject_name) = LOWER(?)
     ORDER BY r.created_at DESC`,
    [subject]
  )

  const recordings = []
  for (const row of rows) {
    const meeting = await getMeeting(Number(row.meeting_id))
    if (!meeting) continue
    if (!canViewMeeting(user, meeting)) continue
    recordings.push({
      id: String(row.id),
      meetingId: String(row.meeting_id),
      title: String(row.title || meeting.title),
      subjectName: subject,
      groupIds: meeting.groupIds,
      groupNames: meeting.groupNames,
      startTime: meeting.startTime,
      fileUrl: `/api/meetings/recordings/${row.id}/file`,
      originalName: String(row.original_name || ""),
      mimeType: String(row.mime_type || "video/webm"),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    })
  }

  res.json({ success: true, data: recordings })
})

router.get("/:id/recordings", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canViewMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
    return
  }

  res.json({ success: true, data: await listRecordingsForMeeting(meeting.id) })
})

router.post("/:id/recordings", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = meetingId(req)
  const user = await resolveMeetingUser(req.user)
  const meeting = id === null ? null : await getMeeting(id)

  if (!meeting) {
    res.status(404).json({ success: false, message: "Meeting topilmadi" })
    return
  }
  if (!canManageMeeting(user, meeting)) {
    res.status(403).json({ success: false, message: "Yozuv yuklashga ruxsat yo'q" })
    return
  }

  const originalName = textValue(req.query.filename || req.headers["x-file-name"]) || "meeting.webm"
  const ext = path.extname(originalName).toLowerCase()
  if (ext && !ALLOWED_RECORDING_EXTENSIONS.has(ext)) {
    res.status(400).json({ success: false, message: "Bu turdagi fayl qabul qilinmaydi" })
    return
  }
  const contentLength = Number(req.headers["content-length"] || 0)
  if (contentLength > MAX_UPLOAD_BYTES) {
    res.status(413).json({ success: false, message: "Fayl hajmi ruxsat etilgan chegaradan katta" })
    return
  }

  const storedName = sanitizeFilename(originalName)
  const relativePath = `/recordings/${storedName}`
  const absolutePath = path.join(recordingsUploadsDir(), storedName)
  const stream = fs.createWriteStream(absolutePath)
  let written = 0
  let done = false

  function fail(status: number, message: string) {
    if (done) return
    done = true
    req.unpipe(stream)
    stream.destroy()
    fs.rm(absolutePath, { force: true }, () => undefined)
    res.status(status).json({ success: false, message })
  }

  req.on("data", (chunk: Buffer) => {
    written += chunk.length
    if (written > MAX_UPLOAD_BYTES) fail(413, "Fayl hajmi ruxsat etilgan chegaradan katta")
  })
  req.on("error", () => fail(400, "Fayl yuklashda xatolik"))
  stream.on("error", () => fail(500, "Fayl saqlanmadi"))

  stream.on("finish", async () => {
    if (done) return
    done = true
    const recording = await addRecording(meeting.id, user.id, {
      name: storedName,
      originalName,
      mimeType: textValue(req.headers["content-type"]) || "video/webm",
      size: written,
      relativePath,
    })

    // Link recording to lms_subject_resources so it appears in fan resurslari
    if (meeting.subjectName) {
      try {
        const teacherName = textValue(user?.fullName) || "O'qituvchi"
        const recUrl = `/api/meetings/recordings/${recording.id}/file`

        // Try to update existing entry (created when meeting ended)
        const [upd] = await pool.query<ResultSetHeader>(
          `UPDATE lms_subject_resources
           SET file_name=?, original_name=?, mime_type=?, file_size=?, relative_path=?, public_url=?
           WHERE meeting_id=?`,
          [storedName, originalName, recording.mimeType, written, relativePath, recUrl, meeting.id]
        )

        if (upd.affectedRows === 0) {
          // Meeting hasn't ended yet — create a placeholder (will be updated on end)
          await pool.query(
            `INSERT INTO lms_subject_resources
               (uuid, subject_name, title, comment, kind, training_type_name, employee_name, meeting_id,
                file_name, original_name, mime_type, file_size, relative_path, public_url, external_url)
             VALUES (?, ?, ?, ?, 'meeting_video', 'Online dars', ?, ?,
                     ?, ?, ?, ?, ?, ?, NULL)`,
            [
              randomUUID(), meeting.subjectName, meeting.title, meeting.description ?? null,
              teacherName, meeting.id,
              storedName, originalName, recording.mimeType, written, relativePath, recUrl,
            ]
          )
        }
      } catch { /* e'tiborsiz */ }
    }

    res.status(201).json({ success: true, data: recording })
  })

  req.pipe(stream)
})

export default router
