import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { teacherUserId } from "../services/teachingStore"
import {
  isGoogleMeetConfigured,
  buildAuthorizationUrl,
  verifyState,
  completeAuthorization,
  disconnect,
  getConnectionStatus,
} from "../services/googleMeetService"

const router = Router()

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"
const FRONTEND_BASE_PATH = (process.env.FRONTEND_BASE_PATH || "").replace(/\/+$/, "")
const PROFILE_PATH = `${FRONTEND_BASE_PATH}/tizim/profil`

function redirectToProfile(res: Response, query: Record<string, string>) {
  const url = new URL(PROFILE_PATH, FRONTEND_URL)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  res.redirect(url.toString())
}

/* ── GET /api/integrations/google/callback — Google OAuth qaytish nuqtasi.
   MUHIM: bu route authMiddleware'DAN OLDIN ro'yxatdan o'tkaziladi — brauzer
   Google'dan to'g'ridan-to'g'ri qaytadi, hech qanday Authorization header
   yoki cookie kelmaydi. Foydalanuvchi (o'qituvchi) identifikatsiyasi FAQAT
   imzolangan `state` parametri orqali tashiladi (CSRF himoyasi bilan
   birga) — Zoom callback'i bilan bir xil naqsh. ─────────────────────── */
router.get("/callback", async (req, res: Response): Promise<void> => {
  const code = typeof req.query.code === "string" ? req.query.code : ""
  const state = typeof req.query.state === "string" ? req.query.state : ""
  const oauthError = typeof req.query.error === "string" ? req.query.error : ""

  if (oauthError) {
    redirectToProfile(res, { google: "error", message: `Google ruxsat bermadi: ${oauthError}` })
    return
  }
  const decoded = state ? verifyState(state) : null
  if (!decoded || !code) {
    redirectToProfile(res, { google: "error", message: "So'rov muddati tugagan yoki yaroqsiz. Qaytadan urinib ko'ring." })
    return
  }

  try {
    await completeAuthorization(decoded.teacherId, code)
    redirectToProfile(res, { google: "connected" })
  } catch (err) {
    console.warn("[google-meet callback] xato:", err instanceof Error ? err.message : err)
    redirectToProfile(res, { google: "error", message: "Google account ulanmadi. Qaytadan urinib ko'ring." })
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

/* ── GET /api/integrations/google/status ──────────────────────────────── */
router.get("/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  const status = await getConnectionStatus(teacherId)
  res.json({ success: true, data: { ...status, configured: isGoogleMeetConfigured() } })
})

/* ── GET /api/integrations/google/connect — Google authorize URL'ini
   qaytaradi (frontend shu URL'ga window.location bilan o'tadi) ──────── */
router.get("/connect", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  if (!isGoogleMeetConfigured()) {
    res.status(503).json({ success: false, message: "Google Meet integratsiyasi hali serverda sozlanmagan" })
    return
  }
  const url = buildAuthorizationUrl(teacherId)
  res.json({ success: true, data: { url } })
})

/* ── POST /api/integrations/google/disconnect ─────────────────────────── */
router.post("/disconnect", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  await disconnect(teacherId)
  res.json({ success: true, message: "Google account uzildi" })
})

export default router
