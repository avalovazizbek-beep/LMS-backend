import { Router, Request, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { teacherUserId } from "../services/teachingStore"
import {
  isZoomConfigured,
  buildAuthorizationUrl,
  verifyState,
  completeAuthorization,
  disconnect,
  getConnectionStatus,
  syncZoomProfile,
  isZoomWebhookConfigured,
  verifyZoomWebhook,
  zoomUrlValidationResponse,
  handleZoomDeauthorization,
} from "../services/zoomService"
import {
  isZoomReviewEnabled,
  checkZoomReviewCredentials,
  zoomReviewLoginBlocked,
  recordZoomReviewFailure,
  ensureZoomReviewSandbox,
  signZoomReviewToken,
} from "../services/zoomReview"

const router = Router()

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"
const PROFILE_PATH = "/tizim/profil"

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

  // reason — frontend xabarni foydalanuvchi tilida ko'rsatishi uchun
  if (oauthError) {
    redirectToProfile(res, { zoom: "error", reason: "denied", message: `Zoom ruxsat bermadi: ${oauthError}` })
    return
  }
  const decoded = state ? verifyState(state) : null
  if (!decoded || !code) {
    redirectToProfile(res, { zoom: "error", reason: "expired", message: "So'rov muddati tugagan yoki yaroqsiz. Qaytadan urinib ko'ring." })
    return
  }

  try {
    await completeAuthorization(decoded.teacherId, code, decoded.codeVerifier)
    redirectToProfile(res, { zoom: "connected" })
  } catch (err) {
    // Zoom javobining tanasini ham yozamiz — qaysi qadam (token / users/me)
    // va qanday sabab bilan (masalan, scope yetishmasligi) yiqilgani ko'rinsin.
    const ax = err as { config?: { url?: string }; response?: { status?: number; data?: unknown } }
    console.warn(
      "[zoom callback] xato:",
      ax?.config?.url ?? "",
      ax?.response?.status ?? "",
      ax?.response?.data !== undefined ? JSON.stringify(ax.response.data) : err instanceof Error ? err.message : err
    )
    redirectToProfile(res, { zoom: "error", reason: "failed", message: "Zoom account ulanmadi. Qaytadan urinib ko'ring." })
  }
})

/* ── POST /api/integrations/zoom/webhook — Zoom Event Subscription.
   server.ts'da express.json'DAN OLDIN, xom body bilan ulanadi: imzo xom
   matn bo'yicha tekshiriladi. Zoom ilova sozlamasida shu URL va
   "App Deauthorized" hodisasi yoqilgan bo'lishi kerak. ─────────────── */
export async function zoomWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!isZoomWebhookConfigured()) {
    res.status(503).json({ message: "ZOOM_WEBHOOK_SECRET_TOKEN sozlanmagan" })
    return
  }
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : ""
  let body: { event?: string; payload?: Record<string, unknown> }
  try {
    body = JSON.parse(rawBody || "{}")
  } catch {
    res.status(400).json({ message: "JSON noto'g'ri" })
    return
  }

  const signature = req.header("x-zm-signature")
  const timestamp = req.header("x-zm-request-timestamp")
  if (!verifyZoomWebhook(rawBody, signature, timestamp)) {
    res.status(401).json({ message: "Imzo noto'g'ri" })
    return
  }

  if (body.event === "endpoint.url_validation") {
    const plainToken = String(body.payload?.plainToken ?? "")
    res.status(200).json(zoomUrlValidationResponse(plainToken))
    return
  }

  if (body.event === "app_deauthorized") {
    const zoomUserId = String(body.payload?.user_id ?? "")
    try {
      const removed = await handleZoomDeauthorization(zoomUserId)
      console.log(`[zoom webhook] app_deauthorized user=${zoomUserId} — ${removed} ta ulanish ma'lumoti o'chirildi`)
    } catch (err) {
      console.error("[zoom webhook] deauthorization xato:", err instanceof Error ? err.message : err)
      res.status(500).json({ message: "O'chirishda xato" })
      return
    }
  }

  res.status(200).json({ received: true })
}

/* ── POST /api/integrations/zoom/review-login — Zoom Marketplace
   tekshiruvchilari uchun test o'qituvchi hisobi (services/zoomReview.ts).
   .env'da sozlanmagan bo'lsa route yo'qdek 404 qaytaradi. ───────────── */
router.post("/review-login", async (req: Request, res: Response): Promise<void> => {
  if (!isZoomReviewEnabled()) {
    res.status(404).json({ success: false, message: "Not found" })
    return
  }
  const ip = req.ip || "unknown"
  if (zoomReviewLoginBlocked(ip)) {
    res.status(429).json({ success: false, message: "Too many failed attempts. Try again in 15 minutes." })
    return
  }
  const login = typeof req.body?.login === "string" ? req.body.login : ""
  const password = typeof req.body?.password === "string" ? req.body.password : ""
  if (!checkZoomReviewCredentials(login, password)) {
    recordZoomReviewFailure(ip)
    res.status(401).json({ success: false, message: "Wrong username or password" })
    return
  }
  try {
    await ensureZoomReviewSandbox()
  } catch (err) {
    console.error("[zoom review] sandbox guruhni yaratishda xato:", err instanceof Error ? err.message : err)
    res.status(500).json({ success: false, message: "Test account is temporarily unavailable" })
    return
  }
  res.json({ success: true, token: signZoomReviewToken(), role: "employee" })
})

router.use(authMiddleware)

function requireTeacher(req: AuthRequest, res: Response): number | null {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return null
  }
  return teacherUserId(req.user)
}

/* ── GET /api/integrations/zoom/status[?live=1] — live=1 (Profil sahifasi)
   bo'lsa ulangan hisob Zoom'dan (GET /users/me) jonli tekshiriladi;
   meeting formalari esa tez ochilishi uchun faqat DB holatini oladi. ── */
router.get("/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  if (req.query.live === "1" && isZoomConfigured()) await syncZoomProfile(teacherId)
  const status = await getConnectionStatus(teacherId)
  res.json({ success: true, data: { ...status, configured: isZoomConfigured() } })
})

/* ── GET /api/integrations/zoom/connect?ageConfirmed=1 — Zoom authorize
   URL'ini qaytaradi (frontend shu URL'ga window.location bilan o'tadi).
   18+ tasdig'i faqat frontend checkbox'ida qolmasligi uchun shu yerda
   ham talab qilinadi — Zoom EDU age-gate talabi. ────────────────────── */
router.get("/connect", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  if (req.query.ageConfirmed !== "1") {
    res.status(400).json({ success: false, message: "18 yoshdan kattaligingizni tasdiqlang" })
    return
  }
  if (!isZoomConfigured()) {
    res.status(503).json({ success: false, message: "Zoom integratsiyasi hali serverda sozlanmagan" })
    return
  }
  const url = buildAuthorizationUrl(teacherId)
  res.json({ success: true, data: { url } })
})

/* ── POST /api/integrations/zoom/disconnect ───────────────────────────── */
router.post("/disconnect", async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = requireTeacher(req, res)
  if (teacherId === null) return
  await disconnect(teacherId)
  res.json({ success: true, message: "Zoom account uzildi" })
})

export default router
