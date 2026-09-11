import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { getTeacherContent, listSubmissions, teacherUserId } from "../services/teachingStore"
import { runPlagiarismCheck, getCachedPlagiarismResults } from "../services/plagiarismStore"
import { isAdminUser } from "./admin"

const router = Router()
router.use(authMiddleware)

function numVal(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function canAccessContent(req: AuthRequest, teacherUserIdOfContent: number): Promise<boolean> {
  if (req.user?.role === "employee" && teacherUserId(req.user) === teacherUserIdOfContent) return true
  return isAdminUser(req)
}

/* GET /content/:id/results — keshlangan natijalarni qaytaradi (qayta hisoblamaydi) */
router.get("/content/:id/results", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  if (!(await canAccessContent(req, content.teacherUserId))) {
    res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
    return
  }
  res.json({ success: true, data: await getCachedPlagiarismResults(content.id) })
})

/* POST /content/:id/check — barcha topshirilgan ishlarni qayta tekshiradi (talaba-talaba + internet) */
router.post("/content/:id/check", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  if (!(await canAccessContent(req, content.teacherUserId))) {
    res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
    return
  }
  const submissions = await listSubmissions(content.id)
  if (!submissions.length) {
    res.json({ success: true, data: [] })
    return
  }
  try {
    const results = await runPlagiarismCheck(content.id, submissions)
    res.json({ success: true, data: results })
  } catch (err) {
    res.status(500).json({ success: false, message: err instanceof Error ? err.message : "Tekshirishda xatolik yuz berdi" })
  }
})

export default router
