import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import {
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  notificationOwnerOf,
} from "../services/notificationStore"

const router = Router()
router.use(authMiddleware)

// Har bir so'rov faqat o'z egasining (rol + ID) bildirishnomalarini ko'radi
// va o'zgartiradi — boshqa foydalanuvchinikini o'qish/o'chirish mumkin emas.

router.get("/", async (req: AuthRequest, res: Response) => {
  const data = await listNotifications(notificationOwnerOf(req))
  res.json({ success: true, data, unread: data.filter((n) => !n.read).length })
})

router.patch("/read-all", async (req: AuthRequest, res: Response) => {
  await markAllRead(notificationOwnerOf(req))
  res.json({ success: true, message: "Barchasi o'qildi deb belgilandi" })
})

router.patch("/:id/read", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) { res.status(400).json({ success: false, message: "Noto'g'ri ID" }); return }
  const ok = await markRead(notificationOwnerOf(req), id)
  if (!ok) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  res.json({ success: true })
})

router.delete("/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id)) { res.status(400).json({ success: false, message: "Noto'g'ri ID" }); return }
  const ok = await deleteNotification(notificationOwnerOf(req), id)
  if (!ok) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  res.json({ success: true, message: "O'chirildi" })
})

export default router
