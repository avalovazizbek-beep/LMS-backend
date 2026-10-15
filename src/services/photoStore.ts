import type { RowDataPacket } from "mysql2"
import { pool } from "./db"

/* ── Foydalanuvchi suratlari (HEMIS) ──────────────────────────────────
 * HEMIS student-list/employee-list yozuvlaridagi `image` — 320px kesilgan
 * surat (hemis.sies.uz/static/crop/..., ochiq, tokensiz). hemisSync uni
 * to'liq yozuv bilan birga *_directory.profile ustuniga saqlaydi, shu
 * sabab bu yerda HEMIS'ga so'rov yuborilmaydi — faqat lokal MySQL.
 * OAuth bilan kirganlarda login profilidagi `picture` zaxira manba. */

export type PhotoMap = Map<string, string | null>

/** Profil (LONGTEXT JSON yoki obyekt) ichidan surat havolasi. SQL'dagi
 *  JSON_EXTRACT o'rniga shu — bitta buzuq qator butun so'rovni yiqitmaydi. */
export function photoFromProfile(raw: unknown): string | null {
  if (!raw) return null
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw) } catch { return null }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const r = parsed as Record<string, unknown>
  for (const v of [r.image, r.picture, r.image_full]) {
    if (typeof v === "string" && /^https?:\/\//i.test(v.trim())) return v.trim()
  }
  return null
}

function profileText(raw: unknown, ...keys: string[]): string | null {
  if (!raw) return null
  try {
    const r = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
    for (const k of keys) {
      const v = r?.[k]
      if (typeof v === "string" && v.trim()) return v.trim()
      if (typeof v === "number") return String(v)
    }
  } catch { /* noop */ }
  return null
}

/* Katalog har 6 soatda yangilanadi — sahifadan sahifaga o'tganda bir xil
   ID'lar qayta-qayta so'ralmasligi uchun qisqa xotira keshi. */
const CACHE_TTL_MS = 30 * 60 * 1000
const CACHE_MAX = 20000
const cache = new Map<string, { url: string | null; at: number }>()

function cacheGet(key: string): string | null | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined }
  return hit.url
}
function cacheSet(key: string, url: string | null) {
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { url, at: Date.now() })
}

async function withCache(
  kind: string,
  keys: string[],
  resolve: (missing: string[]) => Promise<PhotoMap>,
): Promise<PhotoMap> {
  const out: PhotoMap = new Map()
  const missing: string[] = []
  for (const k of keys) {
    const hit = cacheGet(`${kind}:${k}`)
    if (hit === undefined) missing.push(k)
    else out.set(k, hit)
  }
  if (missing.length) {
    const found = await resolve(missing)
    for (const k of missing) {
      const url = found.get(k) ?? null
      cacheSet(`${kind}:${k}`, url)
      out.set(k, url)
    }
  }
  return out
}

/** Talaba suratlari — HEMIS talaba ID'si (hemis_students_directory.hemis_id) bo'yicha */
export function studentPhotos(ids: number[]): Promise<PhotoMap> {
  return withCache("s", ids.map(String), async (missing) => {
    const found: PhotoMap = new Map()
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT hemis_id, profile FROM hemis_students_directory WHERE hemis_id IN (?)",
      [missing.map(Number)]
    )
    for (const r of rows) found.set(String(r.hemis_id), photoFromProfile(r.profile))
    return found
  })
}

/** Xodim suratlari — katalog ID'si (= teacher_user_id) bo'yicha. Katalogda
 *  bo'lmasa (OAuth akkaunt ID'si bilan kirgan) login profilidagi surat yoki
 *  undagi employee_id_number orqali katalog yozuvi olinadi. */
export function employeePhotos(ids: number[]): Promise<PhotoMap> {
  return withCache("e", ids.map(String), async (missing) => {
    const found: PhotoMap = new Map()
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT hemis_id, profile FROM hemis_employees_directory WHERE hemis_id IN (?)",
      [missing.map(Number)]
    )
    for (const r of rows) {
      const url = photoFromProfile(r.profile)
      if (url) found.set(String(r.hemis_id), url)
    }

    const rest = missing.filter(id => !found.get(id))
    if (!rest.length) return found
    const [huRows] = await pool.query<RowDataPacket[]>(
      `SELECT teacher_user_id, hemis_id, profile FROM hemis_users
        WHERE role = 'employee' AND (teacher_user_id IN (?) OR hemis_id IN (?))`,
      [rest.map(Number), rest]
    )
    const byEmpNo = new Map<string, string>()
    for (const r of huRows) {
      const id = rest.includes(String(r.teacher_user_id)) ? String(r.teacher_user_id) : String(r.hemis_id)
      if (found.get(id)) continue
      const url = photoFromProfile(r.profile)
      if (url) { found.set(id, url); continue }
      const empNo = profileText(r.profile, "employee_id_number", "university_id")
      if (empNo) byEmpNo.set(empNo, id)
    }
    if (byEmpNo.size) {
      const [dirRows] = await pool.query<RowDataPacket[]>(
        "SELECT employee_id_number, profile FROM hemis_employees_directory WHERE employee_id_number IN (?)",
        [[...byEmpNo.keys()]]
      )
      for (const d of dirRows) {
        const id = byEmpNo.get(String(d.employee_id_number))
        const url = photoFromProfile(d.profile)
        if (id && url && !found.get(id)) found.set(id, url)
      }
    }
    return found
  })
}

/** Login / talaba raqami / xodim raqami bo'yicha (masalan face_requests.username
 *  — talabaning student_id_number'i yoki HEMIS logini) */
export function loginPhotos(logins: string[]): Promise<PhotoMap> {
  return withCache("l", logins, async (missing) => {
    const found: PhotoMap = new Map()
    const [sRows] = await pool.query<RowDataPacket[]>(
      `SELECT student_id_number, login, profile FROM hemis_students_directory
        WHERE student_id_number IN (?) OR login IN (?)
        ORDER BY is_active ASC`,
      [missing, missing]
    )
    // is_active ASC — faol yozuv oxirida yozilib, nofaolini bosib ketadi
    for (const r of sRows) {
      const url = photoFromProfile(r.profile)
      if (!url) continue
      if (r.student_id_number && missing.includes(String(r.student_id_number))) found.set(String(r.student_id_number), url)
      if (r.login && missing.includes(String(r.login))) found.set(String(r.login), url)
    }
    const rest = missing.filter(k => !found.get(k))
    if (!rest.length) return found
    const [eRows] = await pool.query<RowDataPacket[]>(
      `SELECT employee_id_number, login, profile FROM hemis_employees_directory
        WHERE employee_id_number IN (?) OR login IN (?)
        ORDER BY is_active ASC`,
      [rest, rest]
    )
    for (const r of eRows) {
      const url = photoFromProfile(r.profile)
      if (!url) continue
      if (r.employee_id_number && rest.includes(String(r.employee_id_number))) found.set(String(r.employee_id_number), url)
      if (r.login && rest.includes(String(r.login))) found.set(String(r.login), url)
    }
    return found
  })
}
