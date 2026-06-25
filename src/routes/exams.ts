import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import { exams, Exam } from "../db/data"
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

router.get("/", (_req, res: Response) => {
  res.json({ success: true, data: exams })
})

router.get("/:id", (req: AuthRequest, res: Response): void => {
  const e = exams.find((e) => e.id === req.params.id)
  if (!e) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  res.json({ success: true, data: e })
})

router.post("/", requireRole("super_admin", "admin", "moderator"), (req: AuthRequest, res: Response): void => {
  const { subject, group, date, time, duration, room, teacher, type } = req.body
  if (!subject || !group || !date || !time) {
    res.status(400).json({ success: false, message: "Majburiy maydonlar to'ldirilmagan" }); return
  }
  const e: Exam = { id: uuid(), subject, group, date, time, duration: duration || "2 soat", room: room || "", teacher: teacher || "", type: type || "Yozma", status: "scheduled", createdAt: new Date().toISOString().slice(0, 10) }
  exams.push(e)
  res.status(201).json({ success: true, data: e })
})

router.put("/:id", requireRole("super_admin", "admin", "moderator"), (req: AuthRequest, res: Response): void => {
  const idx = exams.findIndex((e) => e.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  exams[idx] = { ...exams[idx], ...req.body }
  res.json({ success: true, data: exams[idx] })
})

router.delete("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = exams.findIndex((e) => e.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  exams.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
