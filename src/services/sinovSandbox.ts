import { getTeacherGroupIds } from "./teachingStore"

/* ── Sinov guruhi (scripts/sinov-guruh.ts biriktiradi) ─────────────────
   Real HEMIS ma'lumotiga tegmaydigan guruh: oraliq / mustaqil ish / ball
   taqsimotini sinab ko'rish uchun. HEMIS'da bu guruh yo'q, shu sabab
   o'qituvchining HEMIS nazoratlar ro'yxatiga (oraliq yaratishdagi
   "HEMIS'dagi nazoratlar" oynasi, xodim "Boshqa nazoratlar" sahifasi)
   real oraliqlar bilan bir xil ko'rinishdagi "1-on" / "2-on" qatorlari
   qo'shiladi — oraliq odatdagidek ro'yxatdan tanlab yaratiladi. ───────── */

export const SINOV_GROUP_ID = 990000102
export const SINOV_GROUP_NAME = "SINOV-M-101 (sinov guruhi)"
export const SINOV_SUBJECT = "Sinov fani"

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

const CONTROL_RESOURCES = new Set(["controls", "other-controls"])

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
