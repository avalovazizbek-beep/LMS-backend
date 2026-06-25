import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import { payments, Payment } from "../db/data"
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

router.get("/", requireRole("super_admin", "admin", "moderator"), (_req, res: Response) => {
  const total    = payments.reduce((s, p) => s + p.total, 0)
  const paid     = payments.reduce((s, p) => s + p.paid,  0)
  res.json({ success: true, data: payments, stats: { total, paid, debt: total - paid } })
})

router.get("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const p = payments.find((p) => p.id === req.params.id)
  if (!p) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  res.json({ success: true, data: p })
})

router.post("/", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const { student, group, semester, total, dueDate } = req.body
  if (!student || !group || !semester || !total) {
    res.status(400).json({ success: false, message: "Majburiy maydonlar to'ldirilmagan" }); return
  }
  const p: Payment = { id: uuid(), student, group, semester, total, paid: 0, dueDate: dueDate || "", status: "pending", createdAt: new Date().toISOString().slice(0, 10) }
  payments.push(p)
  res.status(201).json({ success: true, data: p })
})

router.patch("/:id/pay", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = payments.findIndex((p) => p.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  const { amount } = req.body
  if (!amount || amount <= 0) { res.status(400).json({ success: false, message: "Summa noto'g'ri" }); return }
  payments[idx].paid = Math.min(payments[idx].paid + amount, payments[idx].total)
  payments[idx].status = payments[idx].paid >= payments[idx].total ? "paid" : "partial"
  res.json({ success: true, data: payments[idx] })
})

router.put("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = payments.findIndex((p) => p.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  payments[idx] = { ...payments[idx], ...req.body }
  res.json({ success: true, data: payments[idx] })
})

router.delete("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = payments.findIndex((p) => p.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  payments.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
