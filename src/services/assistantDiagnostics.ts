import type mysql from "mysql2/promise"
import { pool } from "./db"
import { listTeacherContent, type TeacherContentRecord } from "./teachingStore"
import { isExamPassed } from "./examStore"
import { normalizeGrade } from "./periodGrades"

/* ── AI yordamchi: o'qituvchining O'Z ma'lumotini tekshirish ──────────────
 * "Nega talabalar keyingi mavzuga o'ta olmayapti?", "Topshiriq yuklaganmanmi?",
 * "Nechta ish baholanmagan?" kabi savollarga model emas, shu kod javob beradi:
 * o'qituvchining mavzu va resurslarini bazadan o'qib, talabalar ko'radigan
 * qoidalar bo'yicha (routes/teaching.ts → GET /content/topics) tekshiradi.
 * Shuning uchun javob aniq va tez; model hech narsa to'qimaydi.
 *
 * TALABA TOMONIDAGI QOIDALAR (shu faylning tekshiruvlari shularga tayanadi):
 *  - Mavzu ichidagi bo'limlar zanjiri: Video → Audio → Taqdimot → Qo'llanma →
 *    Test → Topshiriq. Oldingisi tugamaguncha keyingisi ochilmaydi.
 *  - Video/audio — oxirigacha ko'rilsa/tinglansa; taqdimot/qo'llanma — hamma
 *    sahifasi o'qilsa; test — maksimal ballning 60% i yig'ilsa; topshiriq —
 *    fayl yuklansa (baholanishi shart emas) tugagan hisoblanadi.
 *  - Mavzuning hamma bo'limi tugasa — keyingi mavzu ochiladi.
 *  - Fayli yo'q bo'lim va savoli yo'q test talabaga ko'rinmaydi va zanjirga kirmaydi.
 *  - Muddati o'tgan (yopilgan) yoki hali ochilmagan test/topshiriqni talaba
 *    topshira olmaydi — zanjir shu yerda to'xtaydi. */

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|flv|3gp)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma)$/i
const DOC_EXT = /\.(pdf|ppt|pptx|doc|docx|odp|odt)$/i

export interface Section {
  key: "video" | "audio" | "theory" | "qollanma" | "test" | "assignment"
  label: string
  item: TeacherContentRecord
}

export interface Topic {
  key: string
  title: string
  index: number
  trainingType: string | null
  sections: Section[]
  group: TeacherContentRecord[]
}

export interface Course {
  groupId: number
  groupName: string
  subjectName: string
  topics: Topic[]
}

interface Problem {
  /** "block" — talabalar o'ta olmaydi; "warn" — e'tibor berish kerak */
  level: "block" | "warn"
  text: string
}

const SECTION_LABEL: Record<Section["key"], string> = {
  video: "Video", audio: "Audio", theory: "Taqdimot", qollanma: "Qo'llanma", test: "Test", assignment: "Topshiriq",
}

const fileName = (i: TeacherContentRecord) => i.file?.originalName ?? i.files[0]?.originalName ?? ""
const hasFile = (i: TeacherContentRecord) => !!i.file || i.files.length > 0

function fmtDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** O'qituvchining barcha fan-guruhlari, talaba ko'radigan tartib va zanjir bilan */
export async function loadCourses(teacherId: number): Promise<Course[]> {
  const mine = await listTeacherContent({ teacherUserId: teacherId })
  const pairs = new Map<string, { groupId: number; subjectName: string }>()
  for (const c of mine) {
    if (!c.topicKey || c.groupId == null) continue
    pairs.set(`${c.groupId}|${c.subjectName}`, { groupId: c.groupId, subjectName: c.subjectName })
  }
  const groupIds = [...new Set([...pairs.values()].map((p) => p.groupId))]
  const names = new Map<number, string>()
  if (groupIds.length) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id, name FROM lms_groups WHERE id IN (?)", [groupIds])
    for (const r of rows) names.set(Number(r.id), String(r.name))
  }

  const courses: Course[] = []
  for (const pair of pairs.values()) {
    // Talaba shu guruh + fandagi HAMMA kontentni ko'radi (boshqa o'qituvchiniki ham zanjirga kiradi)
    const items = await listTeacherContent({ groupId: pair.groupId, subjectName: pair.subjectName })
    const map = new Map<string, TeacherContentRecord[]>()
    for (const item of items) {
      if (!item.topicKey) continue
      if (!map.has(item.topicKey)) map.set(item.topicKey, [])
      map.get(item.topicKey)!.push(item)
    }
    const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    const topics: Topic[] = keys.map((key, i) => {
      const group = map.get(key)!
      const marker = group.find((c) => c.type === "mavzu" && c.kind === "topic")
      const media = (kind: string) => group.find((c) => c.type === "mavzu" && c.kind === kind && hasFile(c))
      const sections: Section[] = []
      const push = (k: Section["key"], item: TeacherContentRecord | undefined) => { if (item) sections.push({ key: k, label: SECTION_LABEL[k], item }) }
      push("video", media("video_lesson"))
      push("audio", media("audio"))
      push("theory", media("theory"))
      push("qollanma", media("qollanma"))
      push("test", group.find((c) => c.type === "exam" && c.questionCount > 0))
      push("assignment", group.find((c) => c.type === "assignment"))
      return { key, title: marker?.title ?? group[0].title, index: i + 1, trainingType: marker?.trainingType ?? null, sections, group }
    })
    courses.push({ groupId: pair.groupId, groupName: names.get(pair.groupId) ?? `guruh #${pair.groupId}`, subjectName: pair.subjectName, topics })
  }
  return courses.sort((a, b) => `${a.subjectName}${a.groupName}`.localeCompare(`${b.subjectName}${b.groupName}`))
}

/** Savolda guruh yoki fan nomi tilga olingan bo'lsa — faqat o'shalar */
function pickCourses(courses: Course[], question: string): Course[] {
  const q = question.toLowerCase()
  const byGroup = courses.filter((c) => {
    const code = c.groupName.toLowerCase().split(" ")[0]
    return code.length >= 4 && q.includes(code)
  })
  if (byGroup.length) return byGroup
  const bySubject = courses.filter((c) => {
    const words = c.subjectName.toLowerCase().split(/\s+/).filter((w) => w.length >= 5)
    return words.length > 0 && words.every((w) => q.includes(w.slice(0, Math.max(5, w.length - 2))))
  })
  return bySubject.length ? bySubject : courses
}

/* ── Tekshiruv: nima talabalarni to'xtatib qo'yadi ───────────────────── */

async function stuckOnTests(testIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!testIds.length) return out
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT s.content_id, s.grade, s.attempts_used, c.max_score, c.attempts_count
     FROM lms_submissions s JOIN lms_teacher_content c ON c.id = s.content_id
     WHERE s.content_id IN (?)`, [testIds]
  )
  for (const r of rows) {
    const max = r.max_score != null ? Number(r.max_score) : null
    const limit = r.attempts_count != null ? Number(r.attempts_count) : null
    if (!limit || limit <= 0) continue
    const passed = isExamPassed(normalizeGrade(r.grade != null ? Number(r.grade) : null, max), max && max > 0 ? max : 100)
    if (!passed && Number(r.attempts_used) >= limit) out.set(Number(r.content_id), (out.get(Number(r.content_id)) ?? 0) + 1)
  }
  return out
}

function topicProblems(topic: Topic, teacherId: number, stuck: Map<number, number>): Problem[] {
  const problems: Problem[] = []
  const now = new Date()

  for (const s of topic.sections) {
    const name = fileName(s.item)
    const other = s.item.teacherUserId !== teacherId ? " (boshqa o'qituvchi qo'shgan)" : ""
    const next = "Shu bo'limdan keyingi hamma narsa va keyingi mavzular ochilmaydi."

    if (s.key === "video" && name && !VIDEO_EXT.test(name)) {
      const hint = DOC_EXT.test(name) ? " Bu fayl hujjat/taqdimot — uni \"Taqdimot\" bo'limiga yuklang va Video bo'limidan o'chiring." : " Video bo'limiga faqat video fayl (mp4) yuklang."
      problems.push({ level: "block", text: `Video bo'limiga video bo'lmagan fayl yuklangan: "${name}"${other}. Talaba uni "ko'rib tugata" olmaydi. ${next}${hint}` })
    }
    if (s.key === "audio" && name && !AUDIO_EXT.test(name)) {
      problems.push({ level: "block", text: `Audio bo'limiga audio bo'lmagan fayl yuklangan: "${name}"${other}. Talaba uni tinglab tugata olmaydi. ${next} Audio bo'limiga mp3 yuklang yoki faylni to'g'ri bo'limga ko'chiring.` })
    }
    if ((s.key === "theory" || s.key === "qollanma") && name && !DOC_EXT.test(name)) {
      const hint = VIDEO_EXT.test(name) ? " Bu video fayl — uni \"Video\" bo'limiga yuklang." : " Bu bo'limga PDF, PowerPoint yoki Word fayl yuklang."
      problems.push({ level: "block", text: `${s.label} bo'limiga o'qib bo'lmaydigan fayl yuklangan: "${name}"${other}. Talaba sahifalarini o'qib tugata olmaydi. ${next}${hint}` })
    }

    if (s.key === "test" || s.key === "assignment") {
      const what = s.key === "test" ? "Test" : "Topshiriq"
      const start = new Date(s.item.availableFrom)
      if (s.item.status === "locked" && start > now) {
        problems.push({ level: "block", text: `${what} hali ochilmagan — ${fmtDate(s.item.availableFrom)} da ochiladi${other}. Ungacha talabalar bu mavzuni tugata olmaydi va keyingi mavzuga o'tmaydi.` })
      } else if (s.item.status === "closed" && !s.item.isReopened) {
        problems.push({ level: "block", text: `${what} muddati o'tgan (${fmtDate(s.item.deadline)})${other}. Hali ${s.key === "test" ? "o'tmagan" : "topshirmagan"} talabalar endi topshira olmaydi va keyingi mavzuga o'ta olmaydi. Muddatni uzaytiring yoki mavzuni qayta oching.` })
      }
      if (!s.item.isActive) {
        problems.push({ level: "warn", text: `${what} "Faol emas" (yakunlangan) holatda${other}.` })
      }
    }
    if (s.key === "test") {
      const n = stuck.get(s.item.id) ?? 0
      if (n > 0) problems.push({ level: "block", text: `${n} ta talaba testdan o'ta olmay (60% dan kam), urinishlari (${s.item.attemptsCount} ta) tugagan. Ularga "Qayta urinish" bermaguningizcha keyingi mavzuga o'ta olmaydi.` })
    }
  }

  // Savoli yo'q test — talabaga ko'rinmaydi (to'siq emas, lekin o'qituvchi "test qo'ydim" deb o'ylaydi)
  const emptyTest = topic.group.find((c) => c.type === "exam" && c.questionCount === 0)
  if (emptyTest) problems.push({ level: "warn", text: `Test yaratilgan, lekin savoli yo'q${emptyTest.teacherUserId !== teacherId ? " (boshqa o'qituvchi)" : ""} — talabalarga ko'rinmaydi.` })
  if (topic.trainingType === null) problems.push({ level: "warn", text: "Mavzu turi (Ma'ruza / Amaliyot) belgilanmagan — talabalarda noto'g'ri joyda ko'rinishi yoki ko'rinmasligi mumkin." })
  return problems
}

/** "Nega talabalar keyingi mavzuga o'ta olmayapti / topshiriqni bajara olmayapti?" */
export async function diagnoseProgress(teacherId: number, question: string, whose = false): Promise<string> {
  const body = await diagnose(teacherId, question)
  if (!whose) return body.text
  // "Talabadan bo'lyaptimi yoki mendanmi?" — avval aniq xulosa
  const verdict = body.blocks > 0
    ? `Sabab sizning tomoningizda — talabalarda emas: ${body.blocks} ta mavzuning sozlamasi talabalarni to'xtatib qo'ygan. Ularni tuzatsangiz, talabalar davom eta oladi.`
    : body.scopeEmpty
      ? ""
      : "Sizning sozlamalaringizda xato topilmadi — demak sabab talabalar tomonida: ular mavzudagi bo'limlarni oxirigacha bajarmagan (video oxirigacha ko'rilmagan, taqdimot sahifalari o'qilmagan, testdan 60% olinmagan yoki topshiriq yuklanmagan)."
  return verdict ? `${verdict}\n\n${body.text}` : body.text
}

async function diagnose(teacherId: number, question: string): Promise<{ text: string; blocks: number; scopeEmpty: boolean }> {
  const all = await loadCourses(teacherId)
  if (!all.length) return { text: "Sizda hali mavzu yaratilmagan — tekshiradigan narsa topilmadi. Mavzular «Mavzu va resurslar» sahifasida yaratiladi.", blocks: 0, scopeEmpty: true }
  const courses = pickCourses(all, question)
  const testIds = courses.flatMap((c) => c.topics.flatMap((t) => t.sections.filter((s) => s.key === "test").map((s) => s.item.id)))
  const stuck = await stuckOnTests(testIds)

  const found: Array<{ course: Course; topic: Topic; problems: Problem[] }> = []
  let topicCount = 0
  for (const course of courses) {
    for (const topic of course.topics) {
      topicCount += 1
      const problems = topicProblems(topic, teacherId, stuck)
      if (problems.length) found.push({ course, topic, problems })
    }
  }
  const scope = courses.length === all.length
    ? `${all.length} ta fan-guruhdagi ${topicCount} ta mavzuni`
    : `${courses.map((c) => `${c.groupName} · ${c.subjectName}`).join("; ")} — ${topicCount} ta mavzuni`
  const blocks = found.filter((f) => f.problems.some((p) => p.level === "block"))

  if (!found.length) {
    return { blocks: 0, scopeEmpty: false, text: `${scope} tekshirdim: talabalarni to'xtatib qo'yadigan texnik sabab topilmadi.\n\nEslatma — talaba keyingi mavzuga o'tishi uchun shu mavzudagi hamma bo'limni tartib bilan tugatishi kerak: videoni oxirigacha ko'rish, taqdimotning hamma sahifasini o'qish, testdan kamida 60% olish va topshiriq faylini yuklash. Muayyan talabani tekshirish uchun «Mavzular bo'yicha natijalar» sahifasida uning ismini bosing.` }
  }

  const lines: string[] = [`${scope} tekshirdim. ${blocks.length ? `${blocks.length} ta mavzuda talabalarni to'xtatib qo'yadigan muammo bor:` : "To'xtatib qo'yadigan muammo yo'q, lekin e'tibor beradigan joylar bor:"}`]
  // Avval to'siqlar; juda uzun bo'lmasin
  const ordered = [...blocks, ...found.filter((f) => !blocks.includes(f))].slice(0, 8)
  ordered.forEach((f, i) => {
    lines.push("", `${i + 1}) ${f.course.groupName} · ${f.course.subjectName} · ${f.topic.index}-mavzu «${f.topic.title}»`)
    for (const p of f.problems) lines.push(`   ${p.level === "block" ? "⛔" : "⚠"} ${p.text}`)
  })
  if (found.length > ordered.length) lines.push("", `Yana ${found.length - ordered.length} ta mavzuda eslatma bor — guruh yoki fan nomini yozsangiz, o'shani batafsil ko'rsataman.`)
  return { text: lines.join("\n"), blocks: blocks.length, scopeEmpty: false }
}

/** "Topshiriq / test / video yuklaganmanmi?" — har fan-guruhda nima bor, nima yo'q */
export async function summarizeContent(teacherId: number, question: string): Promise<string> {
  const all = await loadCourses(teacherId)
  if (!all.length) return "Sizda hali mavzu yaratilmagan. Mavzu va materiallar «Mavzu va resurslar» sahifasida qo'shiladi."
  const courses = pickCourses(all, question)
  const q = question.toLowerCase()
  const wanted: Section["key"][] =
    /topshiri/.test(q) ? ["assignment"] : /test/.test(q) ? ["test"] : /video/.test(q) ? ["video"] :
    /taqdimot|prezentatsiya/.test(q) ? ["theory"] : /audio/.test(q) ? ["audio"] : ["video", "theory", "test", "assignment"]

  const lines: string[] = []
  for (const course of courses.slice(0, 10)) {
    lines.push(`${course.groupName} · ${course.subjectName} — ${course.topics.length} ta mavzu:`)
    for (const key of wanted) {
      const without = course.topics.filter((t) => !t.sections.some((s) => s.key === key))
      const withCount = course.topics.length - without.length
      const label = SECTION_LABEL[key].toLowerCase()
      if (!without.length) lines.push(`   ✓ ${label}: hamma mavzuda bor`)
      else if (!withCount) lines.push(`   ✗ ${label}: hech bir mavzuda yo'q`)
      else lines.push(`   • ${label}: ${withCount} ta mavzuda bor, ${without.length} tasida yo'q (${without.slice(0, 6).map((t) => `${t.index}-mavzu`).join(", ")}${without.length > 6 ? "…" : ""})`)
    }
  }
  if (courses.length > 10) lines.push("", `Yana ${courses.length - 10} ta fan-guruh bor — guruh yoki fan nomini yozsangiz, o'shani ko'rsataman.`)
  return lines.join("\n")
}

/** "Nechta ish baholanmagan?" */
export async function pendingGrading(teacherId: number): Promise<string> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT c.title, c.subject_name, g.name AS group_name, COUNT(*) AS n
     FROM lms_submissions s
     JOIN lms_teacher_content c ON c.id = s.content_id
     LEFT JOIN lms_groups g ON g.id = c.group_id
     WHERE c.teacher_user_id = ? AND c.type = 'assignment' AND s.grade IS NULL
     GROUP BY c.id ORDER BY n DESC LIMIT 12`, [teacherId]
  )
  if (!rows.length) return "Baholanmagan ish yo'q — hamma topshirilgan ishlar baholangan."
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0)
  return [`Baholash kutayotgan ishlar${rows.length === 12 ? " (eng ko'pi)" : ""}: jami ${total} ta.`, "",
    ...rows.map((r, i) => `${i + 1}) ${r.group_name ?? "—"} · ${r.subject_name} · «${r.title}» — ${r.n} ta`),
    "", "Baholash «Baholash» sahifasida qilinadi."].join("\n")
}
