import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { getUserAdminRole } from "./admin"
import { askAssistant, assistantHealth, ASSISTANT_MODEL, type ChatTurn } from "../services/assistantService"
import { pageTitle } from "../services/assistantGuide"
import { teacherUserId } from "../services/teachingStore"

/* ── O'qituvchi yordamchisi (AI agent) ──────────────────────────────────
   GET  /api/assistant/status — shu foydalanuvchiga yordamchi ko'rinadimi
   POST /api/assistant/chat   — savol → javob (+ ochiladigan sahifa)

   Sinov bosqichi: faqat ruxsat berilganlarga.
     ASSISTANT_USER_IDS=123,456 — aynan shu xodim ID'lari (lms'dagi userId);
     bo'sh bo'lsa — faqat to'liq admin huquqli xodim.
   Hamma o'qituvchilarga ochish: ASSISTANT_USER_IDS=all ─────────────── */
const router = Router()
router.use(authMiddleware)

const ALLOWED = String(process.env.ASSISTANT_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)

export async function assistantAllowed(req: AuthRequest): Promise<boolean> {
  if (req.user?.role !== "employee") return false
  if (ALLOWED.includes("all")) return true
  const id = String(req.user?.userId ?? req.user?.id ?? "")
  if (ALLOWED.length) return ALLOWED.includes(id)
  return (await getUserAdminRole(req)) === "admin"
}

router.get("/status", async (req: AuthRequest, res: Response): Promise<void> => {
  const enabled = await assistantAllowed(req)
  if (!enabled) { res.json({ success: true, enabled: false }); return }
  const health = await assistantHealth()
  res.json({ success: true, enabled: true, ready: health.ok, reason: health.reason ?? null, model: ASSISTANT_MODEL })
})

const MAX_TURNS = 12
const MAX_CHARS = 2000
// Bitta foydalanuvchidan daqiqasiga ko'pi bilan shuncha savol
const PER_MINUTE = 12
const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const entry = hits.get(userId)
  if (!entry || now > entry.resetAt) {
    hits.set(userId, { count: 1, resetAt: now + 60_000 })
    return false
  }
  entry.count += 1
  return entry.count > PER_MINUTE
}

router.post("/chat", async (req: AuthRequest, res: Response): Promise<void> => {
  if (!(await assistantAllowed(req))) {
    res.status(403).json({ success: false, message: "Yordamchi siz uchun yoqilmagan" })
    return
  }
  if (rateLimited(String(req.user?.userId ?? req.user?.id ?? ""))) {
    res.status(429).json({ success: false, message: "Juda ko'p savol — bir daqiqadan keyin urinib ko'ring" })
    return
  }
  const raw = Array.isArray(req.body?.messages) ? (req.body.messages as unknown[]) : []
  const history: ChatTurn[] = raw
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>) : {}))
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role as ChatTurn["role"], content: String(m.content).trim().slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS)
  if (!history.length || history[history.length - 1].role !== "user") {
    res.status(400).json({ success: false, message: "Savol bo'sh" })
    return
  }
  const page = typeof req.body?.page === "string" && /^\/[\w\-/]{0,120}$/.test(req.body.page) ? req.body.page : null
  // Oldingi javobda taklif qilingan sahifa — "och" / "ha" / "tushuntir" shunga tegishli
  const lastPage = typeof req.body?.lastPage === "string" ? req.body.lastPage : null
  // Oqim rejimi (frontend shuni ishlatadi): javob so'zma-so'z ketadi, har qatorda bitta JSON.
  //   {type:"delta",text} — model yozgan bo'lak; {type:"ping"} — ulanish uzilmasin (model o'ylayapti);
  //   {type:"done",...}   — yakuniy javob (tozalangan matn + ochiladigan sahifa).
  if (req.body?.stream === true) {
    res.status(200)
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("X-Accel-Buffering", "no") // nginx javobni yig'ib turmasin
    res.flushHeaders()
    const send = (obj: Record<string, unknown>) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`) }
    const ping = setInterval(() => send({ type: "ping" }), 10_000)
    try {
      const answer = await askAssistant(history, page, lastPage, (text) => send({ type: "delta", text }), teacherUserId(req.user))
      send({ type: "done", ...answer, pageTitle: pageTitle(answer.page) })
    } catch (err) {
      console.warn("[assistant] model xatosi:", err instanceof Error ? err.message : err)
      send({ type: "error", message: "Yordamchi hozir javob bera olmayapti" })
    } finally {
      clearInterval(ping)
      res.end()
    }
    return
  }
  try {
    const answer = await askAssistant(history, page, lastPage, undefined, teacherUserId(req.user))
    res.json({ success: true, data: { ...answer, pageTitle: pageTitle(answer.page) } })
  } catch (err) {
    console.warn("[assistant] model xatosi:", err instanceof Error ? err.message : err)
    res.status(502).json({ success: false, message: "Yordamchi hozir javob bera olmayapti (model serveri ishlamayapti)" })
  }
})

export default router
