import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { isAdminUser } from "./admin"
import { studentPhotos, employeePhotos, loginPhotos, photoFromProfile, type PhotoMap } from "../services/photoStore"
import { teacherUserId, studentUserId } from "../services/teachingStore"

/* ── /api/photos — HEMIS suratlari (ID → havola) ─────────────────────
 * Frontend'dagi PersonAvatar bir sahifadagi barcha avatarlarni bitta
 * so'rovga yig'ib shu yerdan oladi. Ruxsat: xodim/admin — hammaniki;
 * talaba — o'ziniki va xodimlarniki (boshqa talabalarning suratini ID
 * ketma-ketligi bo'yicha yig'ib olib bo'lmasligi uchun). */

const router = Router()
router.use(authMiddleware)

const MAX_PER_KIND = 200

function idList(value: unknown): number[] {
  const out = new Set<number>()
  for (const part of String(value ?? "").split(",")) {
    const n = Number(part.trim())
    if (Number.isInteger(n) && n > 0) out.add(n)
    if (out.size >= MAX_PER_KIND) break
  }
  return [...out]
}

function textList(value: unknown): string[] {
  const out = new Set<string>()
  for (const part of String(value ?? "").split(",")) {
    const s = part.trim()
    if (s && s.length <= 64) out.add(s)
    if (out.size >= MAX_PER_KIND) break
  }
  return [...out]
}

const toObject = (m: PhotoMap) => Object.fromEntries(m)

async function canSeeAllStudents(req: AuthRequest): Promise<boolean> {
  if (req.user && req.user.role !== "student") return true
  return isAdminUser(req)
}

/* GET /api/photos/me — joriy foydalanuvchining surati */
router.get("/me", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = req.user
  if (!user) { res.status(401).json({ success: false }); return }
  let url: string | null = null
  try {
    if (user.role === "student") {
      const id = studentUserId(user)
      url = (await studentPhotos([id])).get(String(id)) ?? photoFromProfile(user.studentProfile)
    } else {
      const id = teacherUserId(user)
      url = (await employeePhotos([id])).get(String(id)) ?? photoFromProfile(user.employeeProfile)
    }
    if (!url && user.hemisLogin) url = (await loginPhotos([user.hemisLogin])).get(user.hemisLogin) ?? null
  } catch (err) {
    console.warn("[photos/me]", err instanceof Error ? err.message : err)
  }
  // Manzil hamma uchun bir xil (/api/photos/me) — brauzer keshi tokenni
  // hisobga olmaydi: boshqa akkauntga kirilganda oldingi odamning surati
  // chiqib turardi. Frontend sessiya ichida o'zi keshlaydi (lib/photos).
  res.set("Cache-Control", "private, no-store")
  res.json({ success: true, url })
})

/* GET /api/photos?students=1,2&employees=3&logins=AB123 */
router.get("/", async (req: AuthRequest, res: Response): Promise<void> => {
  let students = idList(req.query.students)
  const employees = idList(req.query.employees)
  let logins = textList(req.query.logins)

  if (!(await canSeeAllStudents(req))) {
    const self = studentUserId(req.user)
    students = students.filter(id => id === self)
    const own = [req.user?.hemisLogin, req.user?.username].filter(Boolean)
    logins = logins.filter(l => own.includes(l))
  }

  try {
    const [s, e, l] = await Promise.all([
      students.length ? studentPhotos(students) : Promise.resolve<PhotoMap>(new Map()),
      employees.length ? employeePhotos(employees) : Promise.resolve<PhotoMap>(new Map()),
      logins.length ? loginPhotos(logins) : Promise.resolve<PhotoMap>(new Map()),
    ])
    // Javob kimligiga bog'liq (talaba faqat o'zinikini oladi) — kesh token bo'yicha ajratilsin
    res.set("Cache-Control", "private, max-age=600")
    res.vary("Authorization")
    res.json({ success: true, students: toObject(s), employees: toObject(e), logins: toObject(l) })
  } catch (err) {
    console.warn("[photos]", err instanceof Error ? err.message : err)
    res.status(500).json({ success: false, message: "Suratlarni olishda xatolik" })
  }
})

export default router
