import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { teacherUserId } from "../services/teachingStore"
import {
  isZoomConfigured,
  buildAuthorizationUrl,
  verifyState,
  completeAuthorization,
  disconnect,
  getConnectionStatus,
} from "../services/zoomService"

const router = Router()

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || "").replace(/\/+$/, "")
const PROFILE_PATH = `${FRONTEND_BASE_PATH}/tizim/profil`

function redirectToProfile(res: Response, query: Record<string, string>) {
  const url = new URL(PROFILE_PATH, FRONTEND_URL)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  res.redirect(url.toString())
}

/* ── GET /api/integrations/zoom/callback — Zoom OAuth qaytish nuqtasi.
   MUHIM: bu route authMiddleware'DAN OLDIN ro'yxatdan o'tkaziladi — brauzer
   Zoom'dan to'g'ridan-to'g'ri qaytadi, hech qanday Authorization header
   yoki cookie kelmaydi. Foydalanuvchi (o'qituvchi) identifikatsiyasi
   FAQAT imzolangan `state` parametri orqali tashiladi (CSRF himoyasi
   bilan birga) — meeting join-token bilan bir xil naqsh. ────────────── */
router.get("/callback", async (req, res: Response): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : ""
  const state = typeof req.query.state === "string" ? req.query.state : ""
  const oauthError = typeof req.query.error === "string" ? req.query.error : ""

  if (oauthError) {
    redirectToProfile(res, { zoom: "error", message: `Zoom ruxsat bermadi: ${oauthError}` })
    return
  }
  const decoded = state ? verifyState(state) : null
  if (!decoded || !code) {
    redirectToProfile(res, { zoom: "error", message: "So'rov muddati tugagan yoki yaroqsiz. Qaytadan urinib ko'ring." })
    return
  }

  try {
    await completeAuthorization(decoded.teacherId, code, decoded.codeVerifier)
    redirectToProfile(res, { zoom: "connected" })
  } catch (err) {
    console.warn("[zoom callback] xato:", err instanceof Error ? err.message : err)
    redirectToProfile(res, { zoom: "error", message: "Zoom account ulanmadi. Qaytadan urinib ko'ring." })
  }
})

router.use(authMiddleware)

function requireTeacher(req: AuthRequest, res: Response): number | null {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return null
  }
  return teacherUserId(req.user)
}

/* ── GET /api/integrations/zoom/status ────────────────────────────────── */
router.get("/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  const status = await getConnectionStatus(teacherId)
  res.json({ success: true, data: { ...status, configured: isZoomConfigured() } })
})

/* ── GET /api/integrations/zoom/connect — Zoom authorize URL'ini qaytaradi
   (frontend shu URL'ga window.location bilan o'tadi) ─────────────────── */
router.get("/connect", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  if (!isZoomConfigured()) {
    res.status(503).json({ success: false, message: "Zoom integratsiyasi hali serverda sozlanmagan" })
    return
  }
  res.json({ success: true, data: { url: buildAuthorizationUrl(teacherId) } })
})

/* ── POST /api/integrations/zoom/disconnect ───────────────────────────── */
router.post("/disconnect", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  await disconnect(teacherId)
  res.json({ success: true, message: "Zoom account uzildi" })
})

export default router
