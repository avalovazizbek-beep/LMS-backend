import axios from "axios"
import {
  upsertStudentDirectory,
  upsertEmployeeDirectory,
  upsertDepartmentDirectory,
  upsertSubjectDirectory,
  upsertCurriculumDirectory,
  upsertSemesterDirectory,
  deactivateStaleStudents,
  deactivateStaleEmployees,
  markHemisSyncStarted,
  markHemisSyncFinished,
  markHemisSyncFailed,
  type StudentDirectoryRow,
  type EmployeeDirectoryRow,
  type DepartmentDirectoryRow,
  type SubjectDirectoryRow,
  type CurriculumDirectoryRow,
  type SemesterDirectoryRow,
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

const MAX_PAGE_ATTEMPTS = 4

/** Admin token (HEMIS_TOKEN) bilan /v1/data/* dan bitta sahifa oladi —
 *  navbatga qo'yilgan (throttle). 429 kelsa Retry-After'ga qarab kutib
 *  qayta uradi; tarmoq xatosi/timeout (masalan HEMIS vaqtincha sekin javob
 *  bergani) bo'lsa ham — bittasi butun ko'p yuzlab sahifali sinxronizatsiyani
 *  bekor qilib qo'ymasligi uchun — ortib boruvchi pauza bilan qayta uradi.
 *  MAX_PAGE_ATTEMPTS'dan keyin ham chiqmasa, chindan qattiq muammo deb
 *  yuqoriga uzatiladi (cheksiz urinilmaydi). */
async function fetchDataPage(path: string, params: Record<string, string>) {
  const url = new URL(`${HEMIS_BASE}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  for (let attempt = 0; attempt < MAX_PAGE_ATTEMPTS; attempt++) {
    await throttle()
    try {
      const { data } = await axios.get(url.toString(), {
        headers: { Authorization: `Bearer ${HEMIS_TOKEN}`, Accept: "application/json" },
        timeout: HEMIS_TIMEOUT_MS,
      })
      return { items: normalizeItems(unwrapData(data)), pagination: unwrapPagination(data) }
    } catch (err) {
      const isLastAttempt = attempt === MAX_PAGE_ATTEMPTS - 1
      if (isLastAttempt) throw err

      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) {
        const retryAfterRaw = (err as { response?: { headers?: Record<string, string> } })?.response?.headers?.["retry-after"]
        const retryAfterSec = Number(retryAfterRaw)
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 60_000
        console.warn(`[hemisSync] 429 (${path}) — ${Math.round(waitMs / 1000)}s kutib qayta urinilmoqda (${attempt + 1}/${MAX_PAGE_ATTEMPTS})`)
        await sleep(waitMs)
        continue
      }
      // Boshqa xatolar (tarmoq/timeout/5xx) — HEMIS'ni battar band qilmaslik
      // uchun ortib boruvchi pauza (10s, 20s, 30s...) bilan qayta uriniladi.
      const waitMs = 10_000 * (attempt + 1)
      console.warn(`[hemisSync] xato (${path}): ${err instanceof Error ? err.message : err} — ${Math.round(waitMs / 1000)}s kutib qayta urinilmoqda (${attempt + 1}/${MAX_PAGE_ATTEMPTS})`)
      await sleep(waitMs)
    }
  }
  throw new Error(`${path}: ${MAX_PAGE_ATTEMPTS} marta urinishdan keyin ham muvaffaqiyatsiz`)
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
  // hisobiga muhtoj emas. Shu ro'yxatdan endi tushib qolganlar pastda
  // deactivateStaleStudents orqali is_active=0 qilinadi (DELETE emas —
  // tarixiy ma'lumotlar hemis_id orqali bog'langanicha qoladi).
  const runStartedAt = new Date()
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
  const deactivated = await deactivateStaleStudents(runStartedAt)
  if (deactivated > 0) console.log(`[hemisSync] ${deactivated} talaba endi HEMIS faol ro'yxatida yo'q — inactive qilindi`)
  return rows.length
}

/* ── Xodimlar ──────────────────────────────────────────────────────── */
export async function syncEmployeeDirectory(): Promise<number> {
  const runStartedAt = new Date()
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
  const deactivated = await deactivateStaleEmployees(runStartedAt)
  if (deactivated > 0) console.log(`[hemisSync] ${deactivated} xodim endi HEMIS faol ro'yxatida yo'q — inactive qilindi`)
  return rows.length
}

/* ── Guruhlar ──────────────────────────────────────────────────────── */
export async function syncGroupDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/group-list")
  const groups: SyncedGroup[] = items.map((raw) => {
    const r = asRecord(raw)
    return {
      id: numberValue(r.id) ?? 0,
      name: textValue(r.name) || `Guruh #${numberValue(r.id) ?? 0}`,
      curriculumId: numberValue(r._curriculum),
    }
  }).filter((g) => g.id > 0)

  await upsertGroups(groups)
  return groups.length
}

/* ── O'quv rejalar (/v1/data/curriculum-list) — talabaning ta'lim shakli
   (Kunduzgi/Sirtqi/Kechki/Masofaviy) shu yerda aniqlanadi, guruh yoki
   department orqali emas (production'da tekshirildi: "Magistratura"
   bo'limining o'zi ichida ham Kunduzgi, ham Masofaviy o'quv rejalar
   aralash — bo'lim darajasida ajratib bo'lmaydi). ── */
export async function syncCurriculumDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/curriculum-list")
  const rows: CurriculumDirectoryRow[] = items.map((raw) => {
    const r = asRecord(raw)
    const educationForm = asRecord(r.educationForm)
    const educationType = asRecord(r.educationType)
    return {
      hemis_id: numberValue(r.id) ?? 0,
      name: textValue(r.name) || `O'quv reja #${numberValue(r.id) ?? 0}`,
      education_form_code: textValue(educationForm.code) ?? null,
      education_form_name: textValue(educationForm.name) ?? null,
      education_type_code: textValue(educationType.code) ?? null,
      education_type_name: textValue(educationType.name) ?? null,
    }
  }).filter((r) => r.hemis_id > 0)

  await upsertCurriculumDirectory(rows)
  return rows.length
}

/* ── Fakultet/Kafedra (bitta resurs, structure_type orqali ajratiladi) ── */
export async function syncDepartmentDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/department-list", { active: "all" })
  const rows: DepartmentDirectoryRow[] = items.map((raw) => {
    const r = asRecord(raw)
    const structureType = asRecord(r.structureType)
    return {
      hemis_id: numberValue(r.id) ?? 0,
      name: textValue(r.name) || "Bo'lim",
      code: textValue(r.code) ?? null,
      parent_id: numberValue(r.parent),
      structure_type: textValue(structureType.name) ?? null,
      is_active: r.active !== false,
      profile: raw,
    }
  }).filter((r) => r.hemis_id > 0)

  await upsertDepartmentDirectory(rows)
  return rows.length
}

/* ── Fanlar ────────────────────────────────────────────────────────── */
export async function syncSubjectDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/subject-meta-list")
  const rows: SubjectDirectoryRow[] = items.map((raw) => {
    const r = asRecord(raw)
    const subjectGroup = asRecord(r.subjectGroup)
    const educationType = asRecord(r.educationType)
    return {
      hemis_id: numberValue(r.id) ?? 0,
      name: textValue(r.name) || "Fan",
      code: textValue(r.code) ?? null,
      is_active: r.active !== false,
      subject_group: textValue(subjectGroup.name) ?? null,
      education_type: textValue(educationType.name) ?? null,
    }
  }).filter((r) => r.hemis_id > 0)

  await upsertSubjectDirectory(rows)
  return rows.length
}

/* ── Semestrlar ────────────────────────────────────────────────────────
 * HEMIS'da semestr kalendari har bir o'quv reja (_curriculum) bo'yicha
 * alohida — global "1/2-semestr" ro'yxati emas. Filtrsiz so'rov ham
 * ishlaydi (butun universitet bo'yicha, sahifalab), shu sabab har bir
 * curriculum uchun alohida so'ramasdan, to'g'ridan-to'g'ri shundan
 * o'qiymiz. */
function dateFromUnixSeconds(value: unknown): string | null {
  const num = numberValue(value)
  if (num === null) return null
  return new Date(num * 1000).toISOString().slice(0, 10)
}

export async function syncSemesterDirectory(): Promise<number> {
  const items = await fetchAllPages("/v1/data/semester-list")
  const rows: SemesterDirectoryRow[] = items.map((raw) => {
    const r = asRecord(raw)
    const level = asRecord(r.level)
    return {
      hemis_id: numberValue(r.id) ?? 0,
      code: textValue(r.code) ?? null,
      name: textValue(r.name) || "Semestr",
      curriculum_id: numberValue(r._curriculum),
      education_year: textValue(r._education_year) ?? null,
      level_code: textValue(level.code) ?? null,
      level_name: textValue(level.name) ?? null,
      position: numberValue(r.position),
      is_active: Boolean(r.active),
      is_current: Boolean(r.current),
      start_date: dateFromUnixSeconds(r.start_date),
      end_date: dateFromUnixSeconds(r.end_date),
    }
  }).filter((r) => r.hemis_id > 0)

  await upsertSemesterDirectory(rows)
  return rows.length
}

let syncInFlight: Promise<void> | null = null

/** Bitta resursni sinxronlaydi, xato bo'lsa qolganlarini to'xtatmaydi —
 *  faqat shu resurs uchun 0 qaytaradi va xatoni errors ro'yxatiga yozadi. */
async function syncOneResource(name: string, fn: () => Promise<number>, errors: string[]): Promise<number> {
  try {
    return await fn()
  } catch (err) {
    const message = err instanceof Error ? err.message : "noma'lum xatolik"
    console.error(`[hemisSync] ${name} sinxronlanmadi:`, message)
    errors.push(`${name}: ${message}`)
    return 0
  }
}

/** Har bir resursni (talaba/xodim/guruh/fakultet/fan/semestr) ketma-ket
 *  sinxronlaydi va natijani hemis_sync_status + hemis_sync_log'ga yozadi.
 *  Bittasi xato bersa ham (masalan tarmoq uzilib qolsa) qolganlari davom
 *  etadi — "success" faqat hech biri xato bermasa, aks holda "failed"
 *  qilib belgilanadi-yu, lekin muvaffaqiyatli bo'lgan resurslarning
 *  natijalari baribir bazaga yozilgan bo'ladi (har biri o'z upsert'ida
 *  darhol commit qilinadi, umumiy tranzaksiya kutilmaydi).
 *  Bir vaqtning o'zida faqat bitta sinxronizatsiya yurishi mumkin — qo'lda
 *  "hozir sinxronlash" va vaqt jadvali bo'yicha ishga tushish bir-biriga
 *  to'g'ri kelib qolsa, ikkinchisi birinchisi tugashini kutadi. */
export async function runFullHemisSync(): Promise<void> {
  if (syncInFlight) return syncInFlight

  syncInFlight = (async () => {
    if (!HEMIS_TOKEN) {
      console.warn("[hemisSync] HEMIS_TOKEN sozlanmagan — to'liq sinxronizatsiya o'tkazib yuborildi")
      return
    }
    let logId: number | null = null
    const errors: string[] = []
    try {
      logId = await markHemisSyncStarted()
      const students    = await syncOneResource("talaba",          syncStudentDirectory,   errors)
      const employees   = await syncOneResource("xodim",            syncEmployeeDirectory,  errors)
      const groups      = await syncOneResource("guruh",            syncGroupDirectory,     errors)
      const curricula   = await syncOneResource("o'quv reja",       syncCurriculumDirectory, errors)
      const departments = await syncOneResource("fakultet/kafedra", syncDepartmentDirectory, errors)
      const subjects    = await syncOneResource("fan",              syncSubjectDirectory,   errors)
      const semesters   = await syncOneResource("semestr",          syncSemesterDirectory,  errors)
      const counts = { students, employees, groups, departments, subjects, semesters }

      if (errors.length) {
        await markHemisSyncFailed(logId, errors.join(" | "))
        console.warn(`[hemisSync] QISMAN tugadi (${errors.length} ta resurs xato berdi) —`, { ...counts, curricula }, errors)
      } else {
        await markHemisSyncFinished(logId, counts)
        console.log(
          `[hemisSync] tayyor — talaba: ${students}, xodim: ${employees}, guruh: ${groups}, o'quv reja: ${curricula}, ` +
          `fakultet/kafedra: ${departments}, fan: ${subjects}, semestr: ${semesters}`
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "HEMIS sinxronizatsiyasida noma'lum xatolik"
      console.error("[hemisSync] xato:", message)
      await markHemisSyncFailed(logId, message)
    }
  })()

  try {
    await syncInFlight
  } finally {
    syncInFlight = null
  }
}
