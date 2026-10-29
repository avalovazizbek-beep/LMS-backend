import crypto from "crypto"
import jwt from "jsonwebtoken"
import type mysql from "mysql2/promise"
import type { NextFunction, Request, Response } from "express"
import { pool } from "./db"
import { getTeacherGroupIds } from "./teachingStore"
import {
  SINOV_GROUP_ID, SINOV_GROUP_NAME, SINOV_SUBJECT, SINOV_STUDENT_ID, SINOV_STUDENT_LOGIN, SINOV_STUDENT_NAME,
} from "./sinovIds"

export { SINOV_GROUP_ID, SINOV_GROUP_NAME, SINOV_SUBJECT, SINOV_STUDENT_ID, SINOV_STUDENT_LOGIN, SINOV_STUDENT_NAME }

/* ── Sinov guruhi (scripts/sinov-guruh.ts biriktiradi) ─────────────────
   Real HEMIS ma'lumotiga tegmaydigan guruh: oraliq / mustaqil ish / ball
   taqsimotini sinab ko'rish uchun. HEMIS'da bu guruh yo'q, shu sabab
   o'qituvchining HEMIS nazoratlar ro'yxatiga (oraliq yaratishdagi
   "HEMIS'dagi nazoratlar" oynasi, xodim "Boshqa nazoratlar" sahifasi)
   real oraliqlar bilan bir xil ko'rinishdagi "1-on" / "2-on" qatorlari
   qo'shiladi — oraliq odatdagidek ro'yxatdan tanlab yaratiladi. ───────── */

/** HEMIS examDate — mahalliy sananing UTC yarim tuni (sekund) */
function hemisDate(daysFromToday: number): number {
  const d = new Date()
  d.setDate(d.getDate() + daysFromToday)
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 1000
}

/** HEMIS subject-exam-list yozuvi ko'rinishida (2026-27 da oraliq "1-on" / "2-on" deb keladi) */
function sinovControlItems(): Record<string, unknown>[] {
  return [
    { n: 1, days: 0 },
    { n: 2, days: 7 },
  ].map(({ n, days }) => ({
    id: `sinov-on${n}`,
    examType: { code: "17", name: `${n}-on` },
    group: { id: SINOV_GROUP_ID, name: SINOV_GROUP_NAME },
    subject: { id: 0, name: SINOV_SUBJECT },
    examDate: hemisDate(days),
    lessonPair: { code: "sinov", name: "1", start_time: "08:00", end_time: "23:00" },
  }))
}

// "1-on"/"2-on" turidagi nazoratlar "Oraliq nazorat" sahifasida chiqadi (hemis.ts controlKind)
const CONTROL_RESOURCES = new Set(["controls", "midterm-controls"])

/** O'qituvchida sinov guruhi bo'lsa — HEMIS nazoratlar ro'yxatiga sinov oraliqlari qo'shiladi */
export async function withSinovControls<T extends { data: unknown }>(resource: string, teacherId: number, result: T): Promise<T> {
  if (!CONTROL_RESOURCES.has(resource)) return result
  if (!(await getTeacherGroupIds(teacherId)).includes(SINOV_GROUP_ID)) return result
  if (Array.isArray(result.data)) return { ...result, data: [...result.data, ...sinovControlItems()] }
  const record = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : null
  if (record && Array.isArray(record.items)) {
    return { ...result, data: { ...record, items: [...record.items, ...sinovControlItems()] } }
  }
  return { ...result, data: sinovControlItems() }
}

/* ── Sinov talabasi: talaba tomonini ko'rish uchun login + parol ──────
   Parolni scripts/sinov-guruh.ts --student yaratadi va bazaga faqat
   sha256 xeshini yozadi (lms_settings); --remove o'chiradi — shunda kirish
   ham, eski tokenlar ham ishlamaydi. Talaba faqat SINOV-M-101 guruhida;
   HEMIS'ga so'rov ketmaydi (sinovGuard soxta profil / bo'sh javob beradi). */

const JWT_SECRET = process.env.JWT_SECRET || "secret"
export const SINOV_PASSWORD_SETTING = "sinov_student_password_sha256"

function sha256(text: string): Buffer {
  return crypto.createHash("sha256").update(text, "utf8").digest()
}

let hashCache: { value: string | null; at: number } | null = null
async function storedPasswordHash(): Promise<string | null> {
  if (hashCache && Date.now() - hashCache.at < 30_000) return hashCache.value
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT value FROM lms_settings WHERE key_name = ? LIMIT 1", [SINOV_PASSWORD_SETTING]
  )
  const value = rows[0]?.value && /^[0-9a-f]{64}$/.test(String(rows[0].value)) ? String(rows[0].value) : null
  hashCache = { value, at: Date.now() }
  return value
}

export async function checkSinovStudent(login: string, password: string): Promise<boolean> {
  const hash = await storedPasswordHash()
  if (!hash) return false
  const loginOk = crypto.timingSafeEqual(sha256(login.trim().toLowerCase()), sha256(SINOV_STUDENT_LOGIN))
  const passwordOk = crypto.timingSafeEqual(sha256(password), Buffer.from(hash, "hex"))
  return loginOk && passwordOk
}

/* Parol tanlashga qarshi: bitta IP'dan 15 daqiqada 10 ta xato */
const failures = new Map<string, { count: number; resetAt: number }>()
export function sinovLoginBlocked(ip: string): boolean {
  const entry = failures.get(ip)
  if (!entry) return false
  if (Date.now() > entry.resetAt) { failures.delete(ip); return false }
  return entry.count >= 10
}
export function recordSinovFailure(ip: string): void {
  const entry = failures.get(ip)
  if (!entry || Date.now() > entry.resetAt) failures.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 })
  else entry.count += 1
}

export function signSinovStudentToken(): string {
  return jwt.sign(
    {
      id: SINOV_STUDENT_ID,
      userId: SINOV_STUDENT_ID,
      hemisToken: "sinov",
      sinov: true,
      role: "student",
      username: SINOV_STUDENT_NAME,
      fullName: SINOV_STUDENT_NAME,
      hemisLogin: SINOV_STUDENT_LOGIN,
      groupId: SINOV_GROUP_ID,
      studentAuthMode: "password",
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  )
}

/** /hemis/me o'rniga — HEMIS talaba profili ko'rinishida */
function sinovStudentProfile() {
  return {
    id: SINOV_STUDENT_ID,
    first_name: "SINOV",
    second_name: "TALABA",
    third_name: "",
    full_name: SINOV_STUDENT_NAME,
    short_name: SINOV_STUDENT_NAME,
    student_id_number: "SINOV-0001",
    group: { id: SINOV_GROUP_ID, name: SINOV_GROUP_NAME },
    faculty: { id: 0, name: "Sinov (demo)" },
    specialty: { id: 0, name: "Sinov (demo)" },
    educationForm: { id: 0, name: "Masofaviy" },
    level: { id: 0, name: "1-kurs" },
  }
}

function rawToken(req: Request): string | null {
  const header = req.headers.authorization
  if (header?.startsWith("Bearer ")) return header.slice(7)
  return typeof req.query?.token === "string" ? req.query.token : null
}

function isSinovToken(raw: string | null): boolean {
  if (!raw) return false
  try {
    return (jwt.verify(raw, JWT_SECRET) as { sinov?: boolean }).sinov === true
  } catch {
    return false // yaroqsiz token — authMiddleware o'zi rad etadi
  }
}

/** server.ts'da `/api` ostidagi barcha route'lardan OLDIN ulanadi. */
export async function sinovGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isSinovToken(rawToken(req))) {
    next()
    return
  }
  try {
    if (!(await storedPasswordHash())) {
      res.status(401).json({ success: false, message: "Sinov hisobi o'chirilgan" })
      return
    }
  } catch {
    res.status(503).json({ success: false, message: "Sinov hisobi vaqtincha ishlamayapti" })
    return
  }
  // HEMIS'da bu talaba yo'q: profil — soxta, qolgan o'qish so'rovlari — bo'sh
  if (req.path.startsWith("/hemis/")) {
    if (req.method !== "GET") {
      res.status(403).json({ success: false, message: "Sinov hisobida mavjud emas" })
      return
    }
    res.json({ success: true, data: req.path === "/hemis/me" ? sinovStudentProfile() : [], source: "sinov" })
    return
  }
  next()
}
