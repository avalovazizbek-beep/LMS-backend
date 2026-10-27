import crypto from "crypto"
import jwt from "jsonwebtoken"
import type { NextFunction, Request, Response } from "express"
import { addTeacherGroups, upsertGroups } from "./teachingStore"

/* ── Zoom Marketplace tekshiruvchilari uchun test hisobi ───────────────
   Zoom reviewerlari HEMIS hisobiga ega emas, lekin ilovani (avtorizatsiya,
   har bir scope, meeting yaratish, uzish) o'zlari sinab ko'rishi shart.
   Shu sabab login+parol bilan kiriladigan BITTA o'qituvchi hisobi bor:
     ZOOM_REVIEW_LOGIN            — masalan zoom.reviewer
     ZOOM_REVIEW_PASSWORD_SHA256  — parolning sha256 hex qiymati (64 belgi)
   Ikkalasi ham bo'lmasa — funksiya butunlay o'chiq (login 404, eski
   tokenlar 401). Ko'rib chiqish tugagach .env'dan olib tashlash kifoya.

   Hisob real ma'lumotdan ajratilgan:
   - id'lar HEMIS'da hech qachon uchramaydigan diapazonda (9501/9601 kabi
     demo id'lar real talabalar bilan to'qnashgan edi);
   - yagona guruhi — talabasiz "qum quti" guruh;
   - HEMIS'ga hech qanday so'rov ketmaydi va faqat Profil/Meeting
     sahifalari ishlatadigan API'lar ochiq (zoomReviewGuard). ────────── */

const JWT_SECRET = process.env.JWT_SECRET || "secret"
const REVIEW_LOGIN = (process.env.ZOOM_REVIEW_LOGIN || "").trim().toLowerCase()
const REVIEW_PASSWORD_SHA256 = (process.env.ZOOM_REVIEW_PASSWORD_SHA256 || "").trim().toLowerCase()

export const ZOOM_REVIEW_TEACHER_ID = 990000001
export const ZOOM_REVIEW_GROUP_ID = 990000101
export const ZOOM_REVIEW_GROUP_NAME = "ZOOM-M-TEST (Zoom review sandbox)"
const ZOOM_REVIEW_HEMIS_TOKEN = "zoom-review"
const ZOOM_REVIEW_FULL_NAME = "Zoom Reviewer (test teacher)"

export function isZoomReviewEnabled(): boolean {
  return !!REVIEW_LOGIN && /^[0-9a-f]{64}$/.test(REVIEW_PASSWORD_SHA256)
}

function sha256(text: string): Buffer {
  return crypto.createHash("sha256").update(text, "utf8").digest()
}

export function checkZoomReviewCredentials(login: string, password: string): boolean {
  if (!isZoomReviewEnabled()) return false
  const loginOk = crypto.timingSafeEqual(sha256(login.trim().toLowerCase()), sha256(REVIEW_LOGIN))
  const passwordOk = crypto.timingSafeEqual(sha256(password), Buffer.from(REVIEW_PASSWORD_SHA256, "hex"))
  return loginOk && passwordOk
}

/* Parol tanlash hujumiga qarshi: bitta IP'dan 15 daqiqada 10 ta xato urinish */
const FAIL_WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 10
const failures = new Map<string, { count: number; resetAt: number }>()

export function zoomReviewLoginBlocked(ip: string): boolean {
  const entry = failures.get(ip)
  if (!entry) return false
  if (Date.now() > entry.resetAt) {
    failures.delete(ip)
    return false
  }
  return entry.count >= MAX_FAILS
}

export function recordZoomReviewFailure(ip: string): void {
  const entry = failures.get(ip)
  if (!entry || Date.now() > entry.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS })
  else entry.count += 1
}

function reviewEmployeeProfile() {
  return {
    id: ZOOM_REVIEW_TEACHER_ID,
    first_name: "Zoom",
    second_name: "Reviewer",
    third_name: "",
    full_name: ZOOM_REVIEW_FULL_NAME,
    short_name: ZOOM_REVIEW_FULL_NAME,
    employee_id_number: "ZOOM-REVIEW",
    department: { id: 0, name: "Zoom Marketplace review (test account)" },
    staffPosition: { id: 0, name: "Teacher (test account)" },
    employeeType: { id: 0, name: "O'qituvchi" },
    employeeStatus: { id: 0, name: "Faol" },
    active: true,
  }
}

/** Sandbox guruhni va uni test o'qituvchiga biriktirishni kafolatlaydi
 *  (har login'da — kimdir bazadan o'chirib yuborgan bo'lsa ham tiklanadi). */
export async function ensureZoomReviewSandbox(): Promise<void> {
  await upsertGroups([{ id: ZOOM_REVIEW_GROUP_ID, name: ZOOM_REVIEW_GROUP_NAME }])
  await addTeacherGroups(ZOOM_REVIEW_TEACHER_ID, [ZOOM_REVIEW_GROUP_ID])
}

export function signZoomReviewToken(): string {
  return jwt.sign(
    {
      id: ZOOM_REVIEW_TEACHER_ID,
      userId: ZOOM_REVIEW_TEACHER_ID,
      hemisToken: ZOOM_REVIEW_HEMIS_TOKEN,
      zoomReview: true,
      role: "employee",
      isEmployee: true,
      username: ZOOM_REVIEW_FULL_NAME,
      fullName: ZOOM_REVIEW_FULL_NAME,
      hemisLogin: REVIEW_LOGIN,
      teacherGroupIds: [ZOOM_REVIEW_GROUP_ID],
      employeeType: "O'qituvchi",
      employeeProfile: reviewEmployeeProfile(),
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  )
}

/* ── Test hisobi uchun ochiq API'lar ────────────────────────────────────
   Faqat Zoom oqimi (Profil → ulash/uzish, Meeting → yaratish/boshlash)
   va sahifa qobig'i (header, bildirishnomalar) ishlatadiganlari. Qolgan
   hamma narsa — HEMIS proksi, talabalar, rasmlar, e'lonlar, admin —
   403: oddiy o'qituvchi hisobida ochiq bo'lgan keng ruxsatlar (masalan
   istalgan talaba surati) tashqi tekshiruvchiga berilmaydi. ─────────── */
const ALLOWED: Array<[method: string, path: RegExp]> = [
  ["*", /^\/integrations\/zoom(\/|$)/],
  ["GET", /^\/integrations\/google\/status$/],
  ["*", /^\/meetings(\/|$)/],
  ["GET", /^\/teaching\/(groups|exam-settings|certificate|certificate\/template)$/],
  ["POST", /^\/teaching\/certificate\/seen$/],
  ["GET", /^\/auth\/me$/],
  ["GET", /^\/admin\/check$/],
  ["*", /^\/notifications(\/|$)/],
  ["GET", /^\/photos\/me$/],
]

function isAllowed(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => (m === "*" || m === method) && re.test(path))
}

function rawToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith("Bearer ")) return header.slice(7)
  return typeof req.query?.token === "string" ? req.query.token : null
}

function isReviewToken(raw: string | null): boolean {
  if (!raw) return false
  try {
    const payload = jwt.verify(raw, JWT_SECRET) as { zoomReview?: boolean }
    return payload.zoomReview === true
  } catch {
    return false // yaroqsiz token — authMiddleware o'zi rad etadi
  }
}

/** server.ts'da `/api` ostidagi barcha route'lardan OLDIN ulanadi. */
export function zoomReviewGuard(req: Request, res: Response, next: NextFunction): void {
  if (!isReviewToken(rawToken(req))) {
    next()
    return
  }
  if (!isZoomReviewEnabled()) {
    res.status(401).json({ success: false, message: "Test account is disabled" })
    return
  }
  // Header'dagi ism va Profil kartasi — HEMIS'ga so'ramasdan
  if (req.method === "GET" && req.path === "/hemis/employee-me") {
    res.json({ success: true, data: reviewEmployeeProfile(), source: "zoom-review" })
    return
  }
  if (!isAllowed(req.method, req.path)) {
    res.status(403).json({ success: false, message: "Not available for the Zoom review test account" })
    return
  }
  // Meeting faqat sandbox guruhga — real guruh talabalariga "yangi dars"
  // bildirishnomasi ketib qolmasin
  if (req.method === "POST" && req.path === "/meetings") {
    const groupIds: unknown[] = Array.isArray(req.body?.groupIds) ? req.body.groupIds : []
    if (groupIds.some((id) => Number(id) !== ZOOM_REVIEW_GROUP_ID)) {
      res.status(403).json({ success: false, message: "The test account can create meetings only for its sandbox group" })
      return
    }
  }
  next()
}
