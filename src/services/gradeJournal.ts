import { listTeacherContent, topicTrainingType, getSubmissionsBulk, type TeacherContentRecord, type ContentType } from "./teachingStore"
import { getGroupRoster, getAttendanceSummary } from "./attendanceStore"
import {
  computePeriodCells, computeMiScores, miColumns, journalScale, normalizeGrade, pickPeriodExams,
  type JournalScale, type MiColumn, type PeriodKey, type PeriodSource,
} from "./periodGrades"

/* ── Baholar jurnali (o'qituvchi jurnali va talabaning o'z sahifasi) ────
   Ma'ruza (35) = ON1 + ON2 + ma'ruzadan mustaqil ishlar — ballini o'qituvchi
   taqsimlaydi. Amaliyot (35) = amaliyotdan mustaqil ishlar + JN. JN qolgan
   balldan amaliy topshiriqlarga teng bo'linadi: 10 ta topshiriq va 5 ballik
   mustaqil ish bo'lsa — har topshiriq 3 ball; topshiriq 100 ballikda
   baholanadi va foizi shu ulushga aylanadi (80% → 2.4). JN — ulushlar
   yig'indisi: semestr davomida to'planib boradi. Muddati o'tgan,
   topshirilmagan topshiriq — 0; hali ochiq va topshirilmagani — hisobga
   kirmaydi. Fanning barcha o'qituvchilari kontenti bitta jurnalda. ──── */

const JN_TRAINING_TYPE = "Amaliyot"

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function toScaleBall(pct: number, max: number): number {
  return Math.round((Math.min(100, Math.max(0, pct)) * max) / 100)
}

function sumOrNull(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v != null)
  return known.length ? known.reduce((a, b) => a + b, 0) : null
}

/** JN hisobidagi amaliy topshiriq: graded — ball beradigan test/topshiriqlari */
export interface JnTopic {
  key: string
  maxScore: number
  closed: boolean
  graded: { id: number; maxScore: number | null }[]
}

/** Bitta talabaning JN'i: har topshiriq ulushi × foizi, yig'indisi butun songa.
    grades — `${contentId}:${studentId}` → baho (null — topshirilgan, baholanmagan). */
export function studentJn(topics: JnTopic[], share: number, studentId: number, grades: Map<string, number | null>) {
  const topicScores: Record<string, number | null> = {}
  const topicPoints: Record<string, number | null> = {}
  let jnSum = 0
  let counted = false
  for (const tp of topics) {
    let earned = 0
    let graded = false
    let pending = false
    for (const c of tp.graded) {
      const key = `${c.id}:${studentId}`
      if (!grades.has(key)) continue
      const g = grades.get(key)
      if (g == null) { pending = true; continue }   // topshirilgan, hali baholanmagan
      earned += normalizeGrade(g, c.maxScore)
      graded = true
    }
    topicScores[tp.key] = graded ? earned : null
    if (graded) {
      const pts = (share * Math.min(100, (earned / tp.maxScore) * 100)) / 100
      topicPoints[tp.key] = round1(pts)
      jnSum += pts
      counted = true
    } else if (!pending && tp.closed) {
      topicPoints[tp.key] = 0
      counted = true
    } else {
      topicPoints[tp.key] = null
    }
  }
  return { topicScores, topicPoints, jn: counted ? Math.round(jnSum) : null }
}

export interface JournalTopic {
  key: string
  idx: number
  title: string
  /** Topshiriq(lar)ning o'z maksimal bali (test 100, topshiriq — o'qituvchi qo'ygan) */
  maxScore: number
  /** JN'dagi ulushi — JN ÷ amaliy topshiriqlar soni */
  points: number
  types: ContentType[]
}

export interface PeriodItem { id: number; title: string; type: ContentType; questionCount: number; points: number }

export interface JournalStudent {
  userId: number
  fullName: string
  studentIdNumber: string | null
  /** Topshiriqdan olingan xom ball (o'z maksimaliga nisbatan) */
  topicScores: Record<string, number | null>
  /** Topshiriqning JN'ga qo'shgan bali (ulush × foiz, 0.1 aniqlikda) */
  topicPoints: Record<string, number | null>
  jn: number | null
  on1: number | null
  on2: number | null
  miScores: Record<number, number | null>
  mi: number | null
  yn: number | null
  periodSource: { on1: PeriodSource | null; on2: PeriodSource | null; yn: PeriodSource | null }
  attendancePct: number | null
}

export interface GradeJournal {
  topics: JournalTopic[]
  students: JournalStudent[]
  scale: JournalScale
  untypedTopicCount: number
  miColumns: MiColumn[]
  /** ON1 / ON2 / YN qaysi nazoratdan (batafsil ko'rinish uchun) */
  periodItems: Record<PeriodKey, PeriodItem | null>
}

/** `students` berilsa — faqat shular (talabaning o'z sahifasi), aks holda guruh ro'yxati */
export async function buildGradeJournal(
  groupId: number,
  subjectName: string,
  students?: { studentUserId: number; fullName: string; studentIdNumber: string | null }[],
): Promise<GradeJournal> {
  const allContent = await listTeacherContent({ groupId, subjectName })

  const topicMap = new Map<string, TeacherContentRecord[]>()
  for (const c of allContent) {
    if (!c.topicKey) continue
    if (!topicMap.has(c.topicKey)) topicMap.set(c.topicKey, [])
    topicMap.get(c.topicKey)!.push(c)
  }

  // JN faqat amaliyot mavzularidagi test/topshiriqdan. Ma'ruza testlari
  // faqat keyingi mavzuni ochish uchun — ball bermaydi. Savolsiz test
  // talabaga ko'rinmaydi.
  const now = Date.now()
  let untypedTopicCount = 0
  const journalTopics = Array.from(topicMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .flatMap(([key, items]) => {
      const graded = items.filter(c => (c.type === "exam" && c.questionCount > 0) || c.type === "assignment")
      if (!graded.length) return []
      const type = topicTrainingType(items)
      if (type === null) untypedTopicCount++
      if (type !== JN_TRAINING_TYPE) return []
      const marker = items.find(c => c.type === "mavzu" && c.kind === "topic")
      const maxScore = graded.reduce((s, c) => s + (c.maxScore && c.maxScore > 0 ? c.maxScore : 100), 0)
      // Muddati o'tgan (va qayta ochilmagan) topshiriqni topshirmagan talaba 0 oladi
      const closed = !marker?.isReopened &&
        graded.every(c => c.deadline != null && new Date(c.deadline).getTime() < now)
      return [{ key, title: marker?.title ?? graded[0].title, maxScore, graded, closed }]
    })

  const scale = journalScale(allContent)
  const share = journalTopics.length ? scale.jn / journalTopics.length : 0
  const topics: JournalTopic[] = journalTopics.map(({ key, title, maxScore, graded }, i) => ({
    key, idx: i + 1, title, maxScore, points: round1(share), types: [...new Set(graded.map(c => c.type))],
  }))
  const exams = pickPeriodExams(allContent)
  const periodItem = (key: PeriodKey, points: number): PeriodItem | null => {
    const e = exams[key]
    return e ? { id: e.id, title: e.title, type: e.type, questionCount: e.questionCount, points } : null
  }
  const meta = {
    scale,
    untypedTopicCount,
    miColumns: miColumns(allContent),
    periodItems: { ON1: periodItem("ON1", scale.on1), ON2: periodItem("ON2", scale.on2), YN: periodItem("YN", scale.yn) },
  }

  const roster = students ?? (await getGroupRoster(groupId, subjectName))
  if (!roster.length) return { topics, students: [], ...meta }

  const contentIds = Array.from(new Set(journalTopics.flatMap(tp => tp.graded.map(c => c.id))))
  const studentIds = roster.map(s => s.studentUserId)
  const [submissionList, periodCells, miScores, attList] = await Promise.all([
    getSubmissionsBulk(contentIds, studentIds),
    computePeriodCells(groupId, subjectName, allContent, studentIds),
    computeMiScores(allContent, studentIds),
    getAttendanceSummary(groupId, subjectName),
  ])

  const subMap = new Map<string, number | null>()
  for (const s of submissionList) subMap.set(`${s.contentId}:${s.studentUserId}`, s.grade)
  const attMap = new Map<number, number>()
  for (const a of attList) attMap.set(a.studentUserId, a.total > 0 ? Math.round((a.present / a.total) * 100) : 0)

  const rows = roster.map(s => {
    const { topicScores, topicPoints, jn } = studentJn(journalTopics, share, s.studentUserId, subMap)

    const cells = periodCells.get(s.studentUserId)
    const ball = (key: PeriodKey, max: number) => {
      const pct = cells?.[key].pct
      return pct == null ? null : toScaleBall(pct, max)
    }
    const mi = miScores.get(s.studentUserId) ?? {}

    return {
      userId: s.studentUserId,
      fullName: s.fullName,
      studentIdNumber: s.studentIdNumber ?? null,
      topicScores,
      topicPoints,
      jn,
      on1: ball("ON1", scale.on1),
      on2: ball("ON2", scale.on2),
      miScores: mi,
      mi: sumOrNull(Object.values(mi)),
      yn: ball("YN", scale.yn),
      // Katak qayerdan kelgani: test / qo'lda / topshirmagan (0)
      periodSource: {
        on1: cells?.ON1.source ?? null,
        on2: cells?.ON2.source ?? null,
        yn: cells?.YN.source ?? null,
      },
      attendancePct: attMap.get(s.studentUserId) ?? null,
    }
  })

  return { topics, students: rows, ...meta }
}
