import { getSubmissionsBulk, getPeriodGrades, type TeacherContentRecord } from "./teachingStore"
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
  const oraliq = exams.filter((c) => c.controlType === "oraliq").sort(slotOrder)
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
    exam.isActive && exam.questionCount > 0 && !!exam.deadline &&
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
