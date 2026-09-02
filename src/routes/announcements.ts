import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { teacherUserId, studentUserId } from "../services/teachingStore"
import { getAnnouncement, listActiveForUser, dismissForUser, type AnnouncementRecord } from "../services/announcementStore"
import { isAdminUser } from "./admin"
import { streamPrivateFile } from "./teaching"

const router = Router()
router.use(authMiddleware)

function currentUserId(req: AuthRequest): number {
  return req.user?.role === "employee" ? teacherUserId(req.user) : studentUserId(req.user)
}

function toPublicShape(a: AnnouncementRecord) {
  return {
    id: a.id,
    title: a.title,
    message: a.message,
    audience: a.audience,
    createdAt: a.createdAt,
    file: a.file
      ? {
          url: `/api/announcements/${a.id}/file`,
          originalName: a.file.originalName,
          mimeType: a.file.mimeType,
          size: a.file.size,
          mediaKind: a.file.mediaKind,
        }
      : null,
  }
}

/* ── GET /api/announcements/mine — hozirgi foydalanuvchiga mo'ljallangan, ── */
/*    hali yopilmagan (dismiss qilinmagan) faol e'lonlar ────────────────── */
router.get("/mine", async (req: AuthRequest, res: Response): Promise<void> => {
  const role = req.user?.role
  if (role !== "student" && role !== "employee") { res.json({ success: true, data: [] }); return }
  const items = await listActiveForUser(role, currentUserId(req))
  res.json({ success: true, data: items.map(toPublicShape) })
})

/* ── POST /api/announcements/dismiss — bir yoki bir nechta e'lonni yopish ── */
router.post("/dismiss", async (req: AuthRequest, res: Response): Promise<void> => {
  const body = req.body || {}
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : []
  if (!ids.length) { res.status(400).json({ success: false, message: "ids majburiy" }); return }
  await dismissForUser(currentUserId(req), ids)
  res.json({ success: true })
})

/* ── GET /api/announcements/:id/file — biriktirilgan faylni oqish (video/rasm/fayl) ── */
router.get("/:id/file", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) { res.status(400).json({ success: false, message: "Noto'g'ri ID" }); return }

  const announcement = await getAnnouncement(id)
  if (!announcement || !announcement.file) { res.status(404).json({ success: false, message: "Fayl topilmadi" }); return }

  const admin = await isAdminUser(req)
  const targeted = announcement.isActive && (announcement.audience === "all" || announcement.audience === req.user?.role)
  if (!admin && !targeted) { res.status(403).json({ success: false, message: "Ruxsat yo'q" }); return }

  streamPrivateFile(req, res, announcement.file.relativePath, announcement.file.originalName, announcement.file.mimeType)
})

export default router
