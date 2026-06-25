import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import bcrypt from "bcryptjs"
import { users, User } from "../db/data"
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

/* helpers */
const safe = (u: User) => { const { password: _, ...rest } = u; return rest }
const byRole = (role: string) => users.filter((u) => u.role === role).map(safe)

// ── Adminlar ──────────────────────────────────────────────────────
router.get("/admins", requireRole("super_admin", "admin"), (_req, res: Response) => {
  res.json({ success: true, data: byRole("admin").concat(byRole("super_admin")) })
})

router.post("/admins", requireRole("super_admin"), (req: AuthRequest, res: Response): void => {
  const { fullName, username, phone, password, role } = req.body
  if (!fullName || !username || !phone || !password) {
    res.status(400).json({ success: false, message: "Barcha maydonlar to'ldirilishi shart" }); return
  }
  if (users.find((u) => u.username === username)) {
    res.status(409).json({ success: false, message: "Username allaqachon mavjud" }); return
  }
  const user: User = { id: uuid(), fullName, username, phone, password: bcrypt.hashSync(password, 10), role: role || "admin", status: "active", createdAt: new Date().toISOString().slice(0, 10) }
  users.push(user)
  res.status(201).json({ success: true, data: safe(user) })
})

router.put("/admins/:id", requireRole("super_admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  const { password, ...rest } = req.body
  users[idx] = { ...users[idx], ...rest, ...(password ? { password: bcrypt.hashSync(password, 10) } : {}) }
  res.json({ success: true, data: safe(users[idx]) })
})

router.delete("/admins/:id", requireRole("super_admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  users.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

// ── Moderatorlar ──────────────────────────────────────────────────
router.get("/moderators", requireRole("super_admin", "admin"), (_req, res: Response) => {
  res.json({ success: true, data: byRole("moderator") })
})

router.post("/moderators", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const { fullName, username, phone, password } = req.body
  if (!fullName || !username || !phone || !password) {
    res.status(400).json({ success: false, message: "Barcha maydonlar to'ldirilishi shart" }); return
  }
  if (users.find((u) => u.username === username)) {
    res.status(409).json({ success: false, message: "Username allaqachon mavjud" }); return
  }
  const user: User = { id: uuid(), fullName, username, phone, password: bcrypt.hashSync(password, 10), role: "moderator", status: "active", createdAt: new Date().toISOString().slice(0, 10) }
  users.push(user)
  res.status(201).json({ success: true, data: safe(user) })
})

router.put("/moderators/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id && u.role === "moderator")
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  const { password, ...rest } = req.body
  users[idx] = { ...users[idx], ...rest, ...(password ? { password: bcrypt.hashSync(password, 10) } : {}) }
  res.json({ success: true, data: safe(users[idx]) })
})

router.delete("/moderators/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id && u.role === "moderator")
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  users.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

// ── Sotuvchilar ───────────────────────────────────────────────────
router.get("/sellers", requireRole("super_admin", "admin", "moderator"), (_req, res: Response) => {
  res.json({ success: true, data: byRole("seller") })
})

router.post("/sellers", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const { fullName, username, phone, password } = req.body
  if (!fullName || !username || !phone || !password) {
    res.status(400).json({ success: false, message: "Barcha maydonlar to'ldirilishi shart" }); return
  }
  if (users.find((u) => u.username === username)) {
    res.status(409).json({ success: false, message: "Username allaqachon mavjud" }); return
  }
  const user: User = { id: uuid(), fullName, username, phone, password: bcrypt.hashSync(password, 10), role: "seller", status: "active", createdAt: new Date().toISOString().slice(0, 10) }
  users.push(user)
  res.status(201).json({ success: true, data: safe(user) })
})

router.put("/sellers/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id && u.role === "seller")
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  const { password, ...rest } = req.body
  users[idx] = { ...users[idx], ...rest, ...(password ? { password: bcrypt.hashSync(password, 10) } : {}) }
  res.json({ success: true, data: safe(users[idx]) })
})

router.delete("/sellers/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id && u.role === "seller")
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  users.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

// ── Ustalar ───────────────────────────────────────────────────────
router.get("/masters", requireRole("super_admin", "admin", "moderator"), (_req, res: Response) => {
  res.json({ success: true, data: byRole("master") })
})

router.post("/masters", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const { fullName, username, phone, password } = req.body
  if (!fullName || !username || !phone || !password) {
    res.status(400).json({ success: false, message: "Barcha maydonlar to'ldirilishi shart" }); return
  }
  if (users.find((u) => u.username === username)) {
    res.status(409).json({ success: false, message: "Username allaqachon mavjud" }); return
  }
  const user: User = { id: uuid(), fullName, username, phone, password: bcrypt.hashSync(password, 10), role: "master", status: "active", createdAt: new Date().toISOString().slice(0, 10) }
  users.push(user)
  res.status(201).json({ success: true, data: safe(user) })
})

router.put("/masters/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id && u.role === "master")
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  const { password, ...rest } = req.body
  users[idx] = { ...users[idx], ...rest, ...(password ? { password: bcrypt.hashSync(password, 10) } : {}) }
  res.json({ success: true, data: safe(users[idx]) })
})

router.delete("/masters/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = users.findIndex((u) => u.id === req.params.id && u.role === "master")
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  users.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
