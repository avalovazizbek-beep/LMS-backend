import fs from "fs"
import path from "path"
import { randomBytes } from "crypto"
import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import {
  addLocalResource,
  listLocalResources,
  updateLocalResource,
  deleteLocalResource,
  resourceUploadsDir,
  type LocalResourceKind,
} from "../services/localResourceStore"

const router = Router()
const MAX_VIDEO_BYTES = Number(process.env.LOCAL_RESOURCE_MAX_BYTES || 2 * 1024 * 1024 * 1024)
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"])

router.use(authMiddleware)

function textValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function sanitizeFilename(filename: string) {
  const parsed = path.parse(filename || "video.mp4")
  const base = parsed.name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "video"
  const ext = (parsed.ext || ".mp4").toLowerCase()
  return `${base.slice(0, 80)}-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`
}

function safeKind(value: string): LocalResourceKind {
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
  return "video_lesson"
}

function uploaderName(req: AuthRequest) {
  return (
    textValue(req.user?.fullName) ||
    textValue(req.user?.username) ||
    textValue(req.user?.employeeProfile?.full_name) ||
    textValue(req.user?.employeeProfile?.name) ||
    "O'qituvchi"
  )
}

router.get("/", async (req: AuthRequest, res: Response) => {
  const groupId = req.user?.groupId != null ? Number(req.user.groupId) || null : null
  res.json({
    success: true,
    data: await listLocalResources({
      subjectName: textValue(req.query.subject),
      kind: textValue(req.query.kind),
      groupId,
      userRole: req.user?.role,
    }),
  })
})

router.post("/upload", (req: AuthRequest, res: Response): void => {
  const subjectName = textValue(req.query.subjectName || req.headers["x-subject-name"])
  if (!subjectName) {
    res.status(400).json({ success: false, message: "subjectName majburiy" })
    return
  }

  const originalName = textValue(req.query.filename || req.headers["x-file-name"]) || "video.mp4"
  const ext = path.extname(originalName).toLowerCase()
  if (ext && !VIDEO_EXTENSIONS.has(ext)) {
    res.status(400).json({ success: false, message: "Faqat video fayllar yuklanadi" })
    return
  }

  const contentLength = Number(req.headers["content-length"] || 0)
  if (contentLength > MAX_VIDEO_BYTES) {
    res.status(413).json({ success: false, message: "Video hajmi 2GB dan oshmasligi kerak" })
    return
  }

  const storedName = sanitizeFilename(originalName)
  const relativePath = `/resources/${storedName}`
  const absolutePath = path.join(resourceUploadsDir(), storedName)
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
    if (written > MAX_VIDEO_BYTES) fail(413, "Video hajmi 2GB dan oshmasligi kerak")
  })

  req.on("error", () => fail(400, "Video yuklashda xatolik"))
  stream.on("error", () => fail(500, "Video saqlanmadi"))

  stream.on("finish", async () => {
    if (done) return
    done = true
    const record = await addLocalResource({
      subjectId: textValue(req.query.subjectId || req.headers["x-subject-id"]) || undefined,
      subjectName,
      title: textValue(req.query.title || req.headers["x-resource-title"]) || originalName,
      comment: textValue(req.query.comment || req.headers["x-resource-comment"]) || undefined,
      kind: safeKind(textValue(req.query.kind || req.headers["x-resource-kind"])),
      trainingTypeName: textValue(req.query.trainingType || req.headers["x-training-type"]) || undefined,
      employeeName: uploaderName(req),
      meetingId: textValue(req.query.meetingId || req.headers["x-meeting-id"]) || undefined,
      originalName,
      mimeType: textValue(req.headers["content-type"]) || "application/octet-stream",
      size: written,
      relativePath,
      url: `/uploads${relativePath}`,
      externalUrl: textValue(req.query.url || req.headers["x-resource-url"]) || undefined,
    })
    res.status(201).json({ success: true, data: record })
  })

  req.pipe(stream)
})

router.post("/url", async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body || {}
  const subjectName = textValue(body.subjectName)
  const externalUrl = textValue(body.url)
  if (!subjectName) {
    res.status(400).json({ success: false, message: "subjectName majburiy" })
    return
  }
  if (!externalUrl) {
    res.status(400).json({ success: false, message: "url majburiy" })
    return
  }

  const title = textValue(body.title) || externalUrl
  const record = await addLocalResource({
    subjectId: textValue(body.subjectId) || undefined,
    subjectName,
    title,
    comment: textValue(body.comment) || undefined,
    kind: safeKind(textValue(body.kind)),
    trainingTypeName: textValue(body.trainingType) || undefined,
    employeeName: uploaderName(req),
    meetingId: textValue(body.meetingId) || undefined,
    originalName: title,
    mimeType: "text/url",
    size: 0,
    relativePath: "",
    url: externalUrl,
    externalUrl,
  })
  res.status(201).json({ success: true, data: record })
})

router.patch("/:id/toggle", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id
  const records = await listLocalResources()
  const current = records.find((item) => item.id === id)
  if (!current) {
    res.status(404).json({ success: false, message: "Resurs topilmadi" })
    return
  }
  const updated = await updateLocalResource(id, { isActive: !current.isActive })
  res.json({ success: true, data: updated })
})

router.put("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = req.params.id
  const body = req.body || {}
  const patch: { title?: string; comment?: string | null; externalUrl?: string | null; isActive?: boolean } = {}
  if (typeof body.title === "string") patch.title = body.title
  if (body.comment !== undefined) patch.comment = body.comment === null ? null : String(body.comment)
  if (body.externalUrl !== undefined) patch.externalUrl = body.externalUrl === null ? null : String(body.externalUrl)
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive

  const updated = await updateLocalResource(id, patch)
  if (!updated) {
    res.status(404).json({ success: false, message: "Resurs topilmadi" })
    return
  }
  res.json({ success: true, data: updated })
})

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const removed = await deleteLocalResource(req.params.id)
  if (!removed) {
    res.status(404).json({ success: false, message: "Resurs topilmadi" })
    return
  }
  res.json({ success: true })
})

export default router
