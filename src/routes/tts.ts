import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { studentUserId } from "../services/teachingStore"
import { getAccessibilityProfile } from "../services/accessibilityStore"
import { assistantAllowed } from "./assistant"
import { normalizeTtsText, ttsAudio, ttsVoiceFor } from "../services/ttsService"

/* ── POST /api/tts — ovozli yordamchi: matn → MP3 (services/ttsService.ts).
   Faqat admin "maxsus ehtiyojli" deb belgilagan talaba va AI yordamchi
   yoqilgan o'qituvchi (routes/assistant.ts) uchun — boshqalarga
   403 (tashqi xizmatga keraksiz so'rov ketmasin). ───────────────────── */
const router = Router()
router.use(authMiddleware)

// Bitta talabadan daqiqasiga ko'pi bilan shuncha so'rov (sichqoncha tez yurganda ham yetadi)
const PER_MINUTE = 150
const hits = new Map<number, { count: number; resetAt: number }>()

function rateLimited(userId: number): boolean {
  const now = Date.now()
  const entry = hits.get(userId)
  if (!entry || now > entry.resetAt) {
    if (hits.size > 5000) hits.clear()
    hits.set(userId, { count: 1, resetAt: now + 60_000 })
    return false
  }
  entry.count += 1
  return entry.count > PER_MINUTE
}

router.post("/", async (req: AuthRequest, res: Response): Promise<void> => {
  const sId = studentUserId(req.user)
  // Xodim: faqat AI yordamchi yoqilgan o'qituvchi (yordamchi javobini ovozda o'qish uchun)
  const allowed = req.user?.role === "employee"
    ? await assistantAllowed(req)
    : (await getAccessibilityProfile(sId)).enabled
  if (!allowed) {
    res.status(403).json({ success: false, message: "Ovozli yordamchi siz uchun yoqilmagan" })
    return
  }
  if (rateLimited(sId)) {
    res.status(429).json({ success: false, message: "Juda ko'p so'rov — biroz kuting" })
    return
  }
  const text = normalizeTtsText(req.body?.text)
  if (!text) {
    res.status(400).json({ success: false, message: "Matn bo'sh" })
    return
  }
  try {
    const audio = await ttsAudio(text, ttsVoiceFor(req.body?.lang))
    res.setHeader("Content-Type", "audio/mpeg")
    res.setHeader("Content-Length", String(audio.length))
    res.setHeader("Cache-Control", "private, max-age=86400")
    res.end(audio)
  } catch (err) {
    console.warn("[tts] sintez xatosi:", err instanceof Error ? err.message : err)
    res.status(502).json({ success: false, message: "Ovoz xizmati hozir ishlamayapti" })
  }
})

export default router
