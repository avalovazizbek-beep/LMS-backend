import { Router, Request, Response } from "express"
import { recordPlatformSession } from "../services/attendanceStore"
import {
  checkSinovStudent, sinovLoginBlocked, recordSinovFailure, signSinovStudentToken,
  SINOV_GROUP_ID, SINOV_STUDENT_ID, SINOV_STUDENT_NAME,
} from "../services/sinovSandbox"

/* ── POST /api/sinov/login — sinov (demo) talabasi: talaba tomonini ko'rish
   uchun (services/sinovSandbox.ts). Parol scripts/sinov-guruh.ts --student
   bilan yaratilmagan bo'lsa — route yo'qdek 404. ─────────────────────── */
const router = Router()

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const ip = req.ip || "unknown"
  if (sinovLoginBlocked(ip)) {
    res.status(429).json({ success: false, message: "Juda ko'p xato urinish — 15 daqiqadan keyin qayta urining" })
    return
  }
  const login = typeof req.body?.login === "string" ? req.body.login : ""
  const password = typeof req.body?.password === "string" ? req.body.password : ""
  let ok: boolean
  try {
    ok = await checkSinovStudent(login, password)
  } catch {
    res.status(503).json({ success: false, message: "Sinov hisobi vaqtincha ishlamayapti" })
    return
  }
  if (!ok) {
    recordSinovFailure(ip)
    res.status(401).json({ success: false, message: "Login yoki parol noto'g'ri" })
    return
  }
  // Kirish tarixi + o'qituvchi jurnalidagi ro'yxat (HEMIS'da yo'q guruh
  // ro'yxati shu sessiyalardan olinadi)
  void recordPlatformSession(SINOV_STUDENT_ID, SINOV_STUDENT_NAME, SINOV_GROUP_ID, "student", {
    ip: req.ip ?? null,
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
  }).catch(() => undefined)
  res.json({ success: true, token: signSinovStudentToken(), role: "student" })
})

export default router
