import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import { groups, Group } from "../db/data"
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

router.get("/", (_req, res: Response) => {
  res.json({ success: true, data: groups })
})

router.get("/:id", (req: AuthRequest, res: Response): void => {
  const g = groups.find((g) => g.id === req.params.id)
  if (!g) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  res.json({ success: true, data: g })
})

router.post("/", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const { name, course, direction, students, tutor } = req.body
  if (!name || !course || !direction) {
    res.status(400).json({ success: false, message: "Majburiy maydonlar to'ldirilmagan" }); return
  }
  const g: Group = { id: uuid(), name, course, direction, students: students || 0, tutor: tutor || "", status: "active", createdAt: new Date().toISOString().slice(0, 10) }
  groups.push(g)
  res.status(201).json({ success: true, data: g })
})

router.put("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = groups.findIndex((g) => g.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  groups[idx] = { ...groups[idx], ...req.body }
  res.json({ success: true, data: groups[idx] })
})

router.delete("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = groups.findIndex((g) => g.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  groups.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
