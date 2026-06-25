import { Router, Response } from "express"
import { notifications } from "../db/data"
import { authMiddleware, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

router.get("/", (req: AuthRequest, res: Response) => {
  const userId = req.user!.id
  const data = notifications.filter((n) => n.userId === "all" || n.userId === userId)
  res.json({ success: true, data, unread: data.filter((n) => !n.read).length })
})

router.patch("/:id/read", (req: AuthRequest, res: Response): void => {
  const idx = notifications.findIndex((n) => n.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  notifications[idx].read = true
  res.json({ success: true, data: notifications[idx] })
})

router.patch("/read-all", (req: AuthRequest, res: Response) => {
  const userId = req.user!.id
  notifications.forEach((n) => { if (n.userId === "all" || n.userId === userId) n.read = true })
  res.json({ success: true, message: "Barchasi o'qildi deb belgilandi" })
})

router.delete("/:id", (req: AuthRequest, res: Response): void => {
  const idx = notifications.findIndex((n) => n.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  notifications.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
