import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import { documents, Document } from "../db/data"
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

router.get("/", (_req, res: Response) => {
  res.json({ success: true, data: documents })
})

router.post("/", requireRole("super_admin", "admin", "moderator"), (req: AuthRequest, res: Response): void => {
  const { title, category, type, size, author } = req.body
  if (!title || !category) {
    res.status(400).json({ success: false, message: "Majburiy maydonlar to'ldirilmagan" }); return
  }
  const d: Document = { id: uuid(), title, category, type: type || "other", size: size || "0 KB", author: author || "Admin", date: new Date().toISOString().slice(0, 10), downloads: 0 }
  documents.push(d)
  res.status(201).json({ success: true, data: d })
})

router.patch("/:id/download", (req: AuthRequest, res: Response): void => {
  const idx = documents.findIndex((d) => d.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  documents[idx].downloads++
  res.json({ success: true, data: documents[idx] })
})

router.put("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = documents.findIndex((d) => d.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  documents[idx] = { ...documents[idx], ...req.body }
  res.json({ success: true, data: documents[idx] })
})

router.delete("/:id", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = documents.findIndex((d) => d.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  documents.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
