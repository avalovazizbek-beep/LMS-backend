import axios from "axios"
import {
  upsertStudentDirectory,
  upsertEmployeeDirectory,
  markHemisSyncStarted,
  markHemisSyncFinished,
  markHemisSyncFailed,
  type StudentDirectoryRow,
  type EmployeeDirectoryRow,
} from "./db"
import { upsertGroups, type SyncedGroup } from "./teachingStore"

/* ── HEMIS to'liq talaba/xodim/guruh ro'yxati ────────────────────────────
 * Login ("password check") HEMIS'ning /v1/auth/login va /ver1/tutor/auth/login
 * endpointlarida qattiq bloklanadi (IP asosidagi anti-abuse, 429/CAPTCHA_REQUIRED).
 * Bu yerda ishlatiladigan /v1/data/* endpointlari BUTUNLAY BOSHQA, statik admin
 * token (HEMIS_TOKEN) bilan ishlaydigan oila — login blokiga ULARDA umuman
 * duch kelinmaydi. LEKIN (2026-09-15 jonli tekshiruvda aniqlandi): bu oila
 * ham o'zining qattiq chegarasiga ega — javob header'ida `X-Rate-Limit-Limit: 10`
 * qaytadi. Shu sabab pastdagi fetchAllPages hech qachon parallel so'ramaydi —
 * barcha sahifalar (talaba/xodim/guruh — uchalasi umumiy) bitta ketma-ket
 * navbatda, orasida REQUEST_INTERVAL_MS pauza bilan yuboriladi.
 * ────────────────────────────────────────────────────────────────────── */

function normalizeRestBase(value: string) {
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/i, "")
}

const HEMIS_BASE = normalizeRestBase(process.env.HEMIS_BASE || process.env.HEMIS_STUDENT_URL || "https://student.sies.uz/rest")
const HEMIS_TOKEN = process.env.HEMIS_TOKEN || ""
const HEMIS_TIMEOUT_MS = 20_000
const SYNC_PAGE_SIZE = "200"
// O'LCHANGAN FAKT (2026-09-15, jonli HEMIS'ga to'g'ridan-to'g'ri so'rov bilan
// tekshirildi): /v1/data/* ham HEMIS_TOKEN (admin) bilan chaqirilganda ham
// javob header'ida `X-Rate-Limit-Limit: 10` qaytaradi — ya'ni bu oila ham
// /v1/auth/login kabi qattiq (taxminan oynaga 10 so'rov) chegaraga ega, avval
// o'ylanganidek "cheklovsiz" emas. Shu sabab bu yerda BARCHA so'rovlar
// (talaba/xodim/guruh — uchalasi umumiy) bitta ketma-ket navbatga qo'yiladi,
// har biri orasida aniq pauza bilan — parallel emas. 10 000+ talabani to'liq
// olish shu sabab bir necha daqiqa davom etadi, bu KUTILGAN holat (fon
// rejimida ishlaydi, hech kimni kutdirmaydi).
const REQUEST_INTERVAL_MS = 6_500 // ~9.2 so'rov/daqiqa — 10/daqiqa chegaradan xavfsiz pastda

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let lastRequestAt = 0
async function throttle() {
  const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function textValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function unwrapData(value: unknown) {
  const record = asRecord(value)
  const raw = "data" in record ? record.data : "result" in record ? record.result : value
  const rawRecord = asRecord(raw)
  return "items" in rawRecord ? rawRecord.items : raw
}

function unwrapPagination(value: unknown) {
  const record = asRecord(value)
  const raw = "data" in record ? record.data : "result" in record ? record.result : value
  const pagination = asRecord(raw).pagination ?? record.pagination
  return asRecord(pagination)
}

function normalizeItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (Array.isArray(record.items)) return record.items
  return []
}

/** Admin token (HEMIS_TOKEN) bilan /v1/data/* dan bitta sahifa oladi —
 *  navbatga qo'yilgan (throttle), va 429 kelsa Retry-After'ga qarab kutib
 *  bir marta qayta urinadi (butun sinxronizatsiyani bekor qilmaslik uchun,
 *  lekin cheksiz urinib HEMIS'ni battar band qilmaslik uchun ham faqat bir marta). */
async function fetchDataPage(path: string, params: Record<string, string>) {
  const url = new URL(`${HEMIS_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  for (let attempt = 0; attempt < 2; attempt++) {
    await throttle()
    try {
      const { data } = await axios.get(url.toString(), {
        headers: { Authorization: `Bearer ${HEMIS_TOKEN}`, Accept: "application/json" },
        timeout: HEMIS_TIMEOUT_MS,
      })
      return { items: normalizeItems(unwrapData(data)), pagination: unwrapPagination(data) }
    } catch (err) {
      const status = (err as { response?: { status?: number; headers?: Record<string, string> } })?.response?.status
      if (status === 429 && attempt === 0) {
        const retryAfterRaw = (err as { response?: { headers?: Record<string, string> } })?.response?.headers?.["retry-after"]
        const retryAfterSec = Number(retryAfterRaw)
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 60_000
        console.warn(`[hemisSync] 429 (${path}) — ${Math.round(waitMs / 1000)}s kutib bir marta qayta urinilmoqda`)
        await sleep(waitMs)
        continue
      }
      throw err
    }
  }
  throw new Error(`${path}: 429 dan keyin qayta urinish ham muvaffaqiyatsiz`)
}

/** Berilgan /v1/data/* resursidan universitet bo'yicha HAMMA sahifani,
 *  qat'iy ketma-ket (throttle bilan) oladi — HEMIS'ning oynaga ~10 so'rov
 *  chegarasidan xavfsiz pastda qolish uchun parallel emas. */
async function fetchAllPages(path: string, baseParams: Record<string, string> = {}): Promise<unknown[]> {
  const first = await fetchDataPage(path, { ...baseParams, page: "1", limit: SYNC_PAGE_SIZE })
  const pageCount = numberValue(first.pagination.pageCount) ?? 1
  const items = first.items.slice()

  for (let page = 2; page <= pageCount; page++) {
    const next = await fetchDataPage(path, { ...baseParams, page: String(page), limit: SYNC_PAGE_SIZE })
    items.push(...next.items)
  }
  return items
}

/* ── Talabalar ─────────────────────────────────────────────────────── */
export async function syncStudentDirectory(): Promise<number> {
  // _student_status berilmasa HEMIS o'zi default 11 (faol talaba) qo'yadi —
  // aynan shu bizga kerak, chiqarib yuborilgan/bitirgan talabalar LMS
  // hisobiga muhtoj emas.
  const items = await fetchAllPages("/v1/data/student-list")
  const rows: StudentDirectoryRow[] = items.map((raw) => {
    const r = asRecord(raw)
    const group = asRecord(r.group)
    const faculty = asRecord(r.faculty)
    return {
      hemis_id: numberValue(r.id) ?? 0,
      full_name: textValue(r.full_name) || "Talaba",
      student_id_number: textValue(r.student_id_number) ?? null,
      login: textValue(r.login) ?? null,
      group_id: numberValue(group.id),
      group_name: textValue(group.name) ?? null,
      department: textValue(faculty.name) ?? null,
      profile: raw,
    }
  }).filter((r) => r.hemis_id > 0)

  await upsertStudentDirectory(rows)
  return rows.length
}

/* ── Xodimlar ──────────────────────────────────────────────────────── */
export async function syncEmployeeDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/employee-list", { type: "all" })
  const rows: EmployeeDirectoryRow[] = items.map((raw) => {
    const r = asRecord(raw)
    const department = asRecord(r.department)
    const staffPosition = asRecord(r.staffPosition)
    return {
      hemis_id: numberValue(r.id) ?? 0,
      full_name: textValue(r.full_name) || "Xodim",
      employee_id_number: textValue(r.employee_id_number) ?? null,
      login: textValue(r.login) ?? null,
      department: textValue(department.name) ?? null,
      position: textValue(staffPosition.name) ?? null,
      profile: raw,
    }
  }).filter((r) => r.hemis_id > 0)

  await upsertEmployeeDirectory(rows)
  return rows.length
}

/* ── Guruhlar ──────────────────────────────────────────────────────── */
export async function syncGroupDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/group-list")
  const groups: SyncedGroup[] = items.map((raw) => {
    const r = asRecord(raw)
    return { id: numberValue(r.id) ?? 0, name: textValue(r.name) || `Guruh #${numberValue(r.id) ?? 0}` }
  }).filter((g) => g.id > 0)

  await upsertGroups(groups)
  return groups.length
}

let syncInFlight: Promise<void> | null = null

/** Uchala ro'yxatni ketma-ket sinxronlaydi va natijani hemis_sync_status'ga
 *  yozadi. Bir vaqtning o'zida faqat bitta sinxronizatsiya yurishi mumkin —
 *  qo'lda "hozir sinxronlash" va vaqt jadvali bo'yicha ishga tushish bir-biriga
 *  to'g'ri kelib qolsa, ikkinchisi birinchisi tugashini kutadi. */
export async function runFullHemisSync(): Promise<void> {
  if (syncInFlight) return syncInFlight

  syncInFlight = (async () => {
    if (!HEMIS_TOKEN) {
      console.warn("[hemisSync] HEMIS_TOKEN sozlanmagan — to'liq sinxronizatsiya o'tkazib yuborildi")
      return
    }
    await markHemisSyncStarted()
    try {
      const students = await syncStudentDirectory()
      const employees = await syncEmployeeDirectory()
      const groups = await syncGroupDirectory()
      await markHemisSyncFinished({ students, employees, groups })
      console.log(`[hemisSync] tayyor — talaba: ${students}, xodim: ${employees}, guruh: ${groups}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : "HEMIS sinxronizatsiyasida noma'lum xatolik"
      console.error("[hemisSync] xato:", message)
      await markHemisSyncFailed(message)
    }
  })()

  try {
    await syncInFlight
  } finally {
    syncInFlight = null
  }
}
