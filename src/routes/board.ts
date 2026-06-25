import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import { boardPosts, BoardPost } from "../db/data"
import { authMiddleware, requireRole, AuthRequest } from "../middleware/auth"

const router = Router()
router.use(authMiddleware)

router.get("/", (_req, res: Response) => {
  const sorted = [...boardPosts].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
  res.json({ success: true, data: sorted })
})

router.post("/", requireRole("super_admin", "admin", "moderator"), (req: AuthRequest, res: Response): void => {
  const { title, body, tag, author } = req.body
  if (!title || !body) {
    res.status(400).json({ success: false, message: "Sarlavha va matn kiritilishi shart" }); return
  }
  const post: BoardPost = { id: uuid(), title, body, tag: tag || "E'lon", date: new Date().toISOString().slice(0, 10), pinned: false, author: author || req.user!.username }
  boardPosts.push(post)
  res.status(201).json({ success: true, data: post })
})

router.patch("/:id/pin", requireRole("super_admin", "admin"), (req: AuthRequest, res: Response): void => {
  const idx = boardPosts.findIndex((p) => p.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  boardPosts[idx].pinned = !boardPosts[idx].pinned
  res.json({ success: true, data: boardPosts[idx] })
})

router.put("/:id", requireRole("super_admin", "admin", "moderator"), (req: AuthRequest, res: Response): void => {
  const idx = boardPosts.findIndex((p) => p.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  boardPosts[idx] = { ...boardPosts[idx], ...req.body }
  res.json({ success: true, data: boardPosts[idx] })
})

router.delete("/:id", requireRole("super_admin", "admin", "moderator"), (req: AuthRequest, res: Response): void => {
  const idx = boardPosts.findIndex((p) => p.id === req.params.id)
  if (idx === -1) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  boardPosts.splice(idx, 1)
  res.json({ success: true, message: "O'chirildi" })
})

export default router
