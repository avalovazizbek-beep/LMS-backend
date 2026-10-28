import { getSubmissionsBulk, getPeriodGrades, ORALIQ_SLOTS, type TeacherContentRecord, type ContentType } from "./teachingStore"
import { getActiveGrantKeys } from "./retakeStore"

/* ── Davriy baholar (ON1 / ON2 / YN) ──────────────────────────────────
   O'qituvchi jurnali, talabaning o'z sahifasi va admin "Oraliqlar" bo'limi
   bahoni shu yerda bir xil hisoblaydi. Natija 0-100 foiz (jurnal uni
   17/18/30 ballga aylantiradi). Manba ustuvorligi:
     1. O'qituvchi qo'lda yozgan baho — test topshirilgandan KEYIN
        yozilgan bo'lsa (yoki test umuman topshirilmagan bo'lsa);
     2. test natijasi;
     3. oraliq muddati tugagan, talaba topshirmagan va admin unga qayta
        ochmagan bo'lsa — 0 (YN'ga qo'llanmaydi). */

export type PeriodKey = "ON1" | "ON2" | "YN"
export type PeriodSource = "exam" | "manual" | "absent"
export interface PeriodCell { pct: number | null; source: PeriodSource | null }

export const PERIOD_KEYS: PeriodKey[] = ["ON1", "ON2", "YN"]

// Old submissions stored grade as 0-100 percentage; new ones are scaled to contentMaxScore.
// If grade > maxScore (and maxScore > 0 && maxScore < 100), it's old format — convert it.
export function normalizeGrade(grade: number | null | undefined, maxScore: number | null | undefined): number {
  if (!grade) return 0
  const ms = maxScore ?? 0
  if (ms > 0 && ms < 100 && grade > ms) return Math.round((grade / 100) * ms)
  return grade
}

export function examPct(grade: number | null | undefined, maxScore: number | null): number | null {
  if (grade == null) return null
  const max = maxScore && maxScore > 0 ? maxScore : 100
  return Math.min(100, Math.round((normalizeGrade(grade, maxScore) / max) * 100 * 10) / 10)
}

// Faol imtihon nofaolidan oldin, so'ng ochilish vaqti bo'yicha
function slotOrder(a: TeacherContentRecord, b: TeacherContentRecord): number {
  if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
  return new Date(a.availableFrom).getTime() - new Date(b.availableFrom).getTime()
}

/** Guruh+fan kontentidan ON1, ON2 va YN qaysi imtihondan olinishini tanlaydi.
    Oraliq testning o'rni `kind` (ON1/ON2) bilan belgilanadi; belgilanmagan
    eski oraliqlar bo'sh o'rinlarni ochilish vaqti tartibida egallaydi. */
export function pickPeriodExams(content: TeacherContentRecord[]): Record<PeriodKey, TeacherContentRecord | null> {
  const exams = content.filter((c) => c.type === "exam")
  // Oraliq test yoki topshiriq ko'rinishida bo'ladi (yakuniy — faqat test)
  const oraliq = content
    .filter((c) => (c.type === "exam" || c.type === "assignment") && c.controlType === "oraliq")
    .sort(slotOrder)
  let on1 = oraliq.find((c) => c.kind === "ON1") ?? null
  let on2 = oraliq.find((c) => c.kind === "ON2") ?? null
  for (const c of oraliq) {
    if (c.kind === "ON1" || c.kind === "ON2") continue
    if (!on1) on1 = c
    else if (!on2) on2 = c
  }
  const yn = exams.filter((c) => c.controlType === "yakuniy").sort(slotOrder)[0] ?? null
  return { ON1: on1, ON2: on2, YN: yn }
}

export async function computePeriodCells(
  groupId: number,
  subjectName: string,
  content: TeacherContentRecord[],
  studentIds: number[],
): Promise<Map<number, Record<PeriodKey, PeriodCell>>> {
  const exams = pickPeriodExams(content)
  const examIds = PERIOD_KEYS.map((k) => exams[k]?.id).filter((id): id is number => id != null)
  const [subs, manual, grants] = await Promise.all([
    getSubmissionsBulk(examIds, studentIds),
    getPeriodGrades(groupId, subjectName),
    getActiveGrantKeys(examIds),
  ])
  const subMap = new Map(subs.map((s) => [`${s.contentId}:${s.studentUserId}`, s]))
  const manualMap = new Map(manual.map((g) => [`${g.studentUserId}:${g.gradeType}`, g]))
  const now = Date.now()

  const missed = (exam: TeacherContentRecord, studentUserId: number) =>
    exam.isActive && (exam.type === "assignment" || exam.questionCount > 0) && !!exam.deadline &&
    new Date(exam.deadline).getTime() < now && !grants.has(`${exam.id}:${studentUserId}`)

  const out = new Map<number, Record<PeriodKey, PeriodCell>>()
  for (const sId of studentIds) {
    const row = {} as Record<PeriodKey, PeriodCell>
    for (const key of PERIOD_KEYS) {
      const exam = exams[key]
      const hand = manualMap.get(`${sId}:${key}`)
      const sub = exam ? subMap.get(`${exam.id}:${sId}`) : undefined
      const fromExam = sub && exam ? examPct(sub.grade, exam.maxScore) : null
      if (hand && hand.grade != null && (fromExam == null || hand.updatedAt > (sub?.submittedAt ?? 0))) {
        row[key] = { pct: hand.grade, source: "manual" }
      } else if (fromExam != null) {
        row[key] = { pct: fromExam, source: "exam" }
      } else if (key !== "YN" && exam && !sub && missed(exam, sId)) {
        row[key] = { pct: 0, source: "absent" }
      } else {
        row[key] = { pct: null, source: null }
      }
    }
    out.set(sId, row)
  }
  return out
}

/* ── Ball taqsimoti ───────────────────────────────────────────────────
   Ma'ruza qismi 35 ball: ON1 + ON2 + ma'ruzadan mustaqil ishlar.
   Amaliyot qismi 35 ball: amaliyotdan mustaqil ishlar + JN (amaliyot
   mavzulari) — JN'ga mustaqil ishlardan qolgani beriladi. Ballni o'qituvchi
   oraliq / mustaqil ish yaratganda o'zi qo'yadi; ball qo'yilmagan eski
   oraliqlar avvalgidek 17 / 18 hisoblanadi. */

export const PART_TOTAL = 35
export const YN_TOTAL = 30
export const LECTURE_PART = "Ma'ruza"
export const PRACTICE_PART = "Amaliyot"
export const GRADE_PARTS = [LECTURE_PART, PRACTICE_PART] as const
type OraliqSlot = (typeof ORALIQ_SLOTS)[number]
const LEGACY_SLOT_POINTS: Record<OraliqSlot, number> = { ON1: 17, ON2: 18 }

export function slotPoints(exam: TeacherContentRecord, slot: OraliqSlot): number {
  return exam.gradePoints ?? LEGACY_SLOT_POINTS[slot]
}

export function miPart(item: Pick<TeacherContentRecord, "gradePart">): string {
  return item.gradePart === PRACTICE_PART ? PRACTICE_PART : LECTURE_PART
}

/** Mustaqil ish nazorati (oraliq bilan bir joyda yaratiladi) — `control_type` */
export const MUSTAQIL_CONTROL = "mustaqil"

/** Mustaqil ish — Nazoratlar bo'limida (oraliq bilan bir joyda) yaratilgan,
    ball qo'yilgan test/topshiriq (control_type = "mustaqil", mavzusiz).
    Fan resurslaridagi eski "Mustaqil ish" mavzulari hisobga kirmaydi:
    ma'ruzaga yoki amaliyotga tegishli ekani noma'lum — kerak bo'lsa
    o'qituvchi uni Nazoratlarda qayta yaratadi. */
export function pickMiItems(content: TeacherContentRecord[]): TeacherContentRecord[] {
  return content.filter((c) =>
    c.isActive && !c.topicKey && c.controlType === MUSTAQIL_CONTROL &&
    (c.type === "exam" || c.type === "assignment") && c.gradePoints != null && c.gradePoints > 0)
}

export interface BudgetItem { id: number; label: string; title: string; type: ContentType; points: number }
export interface BudgetPart { total: number; used: number; items: BudgetItem[] }
export interface GradeBudget { lecture: BudgetPart; practice: BudgetPart }

export function gradeBudget(content: TeacherContentRecord[]): GradeBudget {
  const exams = pickPeriodExams(content)
  const lecture: BudgetItem[] = []
  const practice: BudgetItem[] = []
  for (const slot of ORALIQ_SLOTS) {
    const e = exams[slot]
    if (e) lecture.push({ id: e.id, label: slot, title: e.title, type: e.type, points: slotPoints(e, slot) })
  }
  // Mustaqil ishlar jurnaldagi kabi: qism ichida yaratilish tartibida MI-1, MI-2...
  for (const col of miColumns(content)) {
    const item = { id: col.id, label: col.label, title: col.title, type: col.type, points: col.points }
    if (col.part === PRACTICE_PART) practice.push(item)
    else lecture.push(item)
  }
  const part = (items: BudgetItem[]): BudgetPart => ({ total: PART_TOTAL, used: items.reduce((s, i) => s + i.points, 0), items })
  return { lecture: part(lecture), practice: part(practice) }
}

/** O'zgarish (yangi yoki tahrirlangan oraliq / mustaqil ish) qo'llangach
    qism 35 balldan oshib ketsa — xato matni, sig'sa — null */
export function budgetError(content: TeacherContentRecord[], candidate: TeacherContentRecord): string | null {
  const after = gradeBudget([...content.filter((c) => c.id !== candidate.id), candidate])
  for (const [name, part] of [[LECTURE_PART, after.lecture], [PRACTICE_PART, after.practice]] as const) {
    const own = part.items.find((i) => i.id === candidate.id)
    if (!own || part.used <= part.total) continue
    const free = Math.max(0, part.total - (part.used - own.points))
    return `${name} uchun ${part.total} balldan ${free} ball qolgan — ${own.points} ball qo'yib bo'lmaydi`
  }
  return null
}

export interface JournalScale { jn: number; on1: number; on2: number; mi: number; lecture: number; practice: number; yn: number }

/** Jurnal ustunlarining maksimal ballari. Hali yaratilmagan oraliq o'rni
    eski 17 / 18 ni oladi, lekin ma'ruzaning qolgan balidan oshmaydi. */
export function journalScale(content: TeacherContentRecord[]): JournalScale {
  const budget = gradeBudget(content)
  const exams = pickPeriodExams(content)
  let free = Math.max(0, PART_TOTAL - budget.lecture.used)
  const on = (slot: OraliqSlot) => {
    const e = exams[slot]
    if (e) return slotPoints(e, slot)
    const v = Math.min(LEGACY_SLOT_POINTS[slot], free)
    free -= v
    return v
  }
  const on1 = on("ON1")
  const on2 = on("ON2")
  const mi = [...budget.lecture.items, ...budget.practice.items]
    .filter((i) => i.label.startsWith("MI"))
    .reduce((s, i) => s + i.points, 0)
  return { jn: Math.max(0, PART_TOTAL - budget.practice.used), on1, on2, mi, lecture: PART_TOTAL, practice: PART_TOTAL, yn: YN_TOTAL }
}

/** Jurnaldagi mustaqil ish ustuni: ma'ruza / amaliyot qismi ichida
    yaratilish tartibida MI-1, MI-2, ... */
export interface MiColumn { id: number; label: string; title: string; part: string; points: number; type: ContentType }

export function miColumns(content: TeacherContentRecord[]): MiColumn[] {
  const items = pickMiItems(content).sort((a, b) =>
    new Date(a.availableFrom).getTime() - new Date(b.availableFrom).getTime() || a.id - b.id)
  const counters = new Map<string, number>()
  return items.map((c) => {
    const part = miPart(c)
    const n = (counters.get(part) ?? 0) + 1
    counters.set(part, n)
    return { id: c.id, label: `MI-${n}`, title: c.title, part, points: c.gradePoints!, type: c.type }
  })
}

/** Har bir mustaqil ishdan olingan ball (o'z balliga nisbatan, butun son).
    Muddati o'tgan, topshirilmagan (qayta ochilmagan) ish — 0; muddati
    tugamagan va hali topshirilmagani yoki baholanmagani — null. */
export async function computeMiScores(
  content: TeacherContentRecord[],
  studentIds: number[],
): Promise<Map<number, Record<number, number | null>>> {
  const items = pickMiItems(content)
  const out = new Map<number, Record<number, number | null>>()
  for (const sId of studentIds) out.set(sId, {})
  if (!items.length || !studentIds.length) return out

  const ids = items.map((c) => c.id)
  const [subs, grants] = await Promise.all([getSubmissionsBulk(ids, studentIds), getActiveGrantKeys(ids)])
  const subMap = new Map(subs.map((s) => [`${s.contentId}:${s.studentUserId}`, s]))
  const reopened = new Set(content.filter((c) => c.type === "mavzu" && c.kind === "topic" && c.isReopened).map((c) => c.topicKey))
  const now = Date.now()
  // Savolsiz testni talaba yecha olmaydi — topshirmaganga 0 qo'yilmaydi
  const takeable = (c: TeacherContentRecord) => c.type === "assignment" || c.questionCount > 0
  const closed = (c: TeacherContentRecord) =>
    !!c.deadline && new Date(c.deadline).getTime() < now && !reopened.has(c.topicKey)

  for (const sId of studentIds) {
    const row = out.get(sId)!
    for (const c of items) {
      const sub = subMap.get(`${c.id}:${sId}`)
      const pct = sub ? examPct(sub.grade, c.maxScore) : null
      if (pct != null) row[c.id] = Math.round((pct * c.gradePoints!) / 100)
      else if (!sub && takeable(c) && closed(c) && !grants.has(`${c.id}:${sId}`)) row[c.id] = 0
      else row[c.id] = null
    }
  }
  return out
}

/** Mustaqil ishlar yig'indisi (talabaning o'z sahifasi uchun); hech biri hisobga kirmasa — null */
export async function computeMiCells(
  content: TeacherContentRecord[],
  studentIds: number[],
): Promise<Map<number, number | null>> {
  const scores = await computeMiScores(content, studentIds)
  const out = new Map<number, number | null>()
  for (const [sId, row] of scores) {
    const values = Object.values(row).filter((v): v is number => v != null)
    out.set(sId, values.length ? values.reduce((a, b) => a + b, 0) : null)
  }
  return out
}
