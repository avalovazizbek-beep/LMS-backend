import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"
import type mysql from "mysql2/promise"
import { pool } from "./db"
import { getTeacherSchedule, privateStorageRoot, storedFilePath, type TeacherContentRecord } from "./teachingStore"
import { loadCourses, type Course, type Topic } from "./assistantDiagnostics"
import { extractFileText, getSubmissionText } from "./submissionText"
import { loadTopicReference, NoTopicError, reviewText } from "./submissionAiReview"
import { convertWithLibreOffice } from "./officeConvert"

/* ── AI yordamchi: bajaradigan ishlar ─────────────────────────────────────
 *  1) Talaba ishini ismi bo'yicha ochib, baho tavsiya qilish
 *     ("Aliyevning ishiga necha baho berasan") — fayl matni (rasm/skaner
 *     bo'lsa OCR bilan) o'qiladi va mavzuga solishtiriladi. Faqat tavsiya.
 *  2) Test yaratish — nechta va qaysi mavzu ekanini so'raydi, o'sha mavzuning
 *     taqdimot / qo'llanmasini o'qib tuzadi va LMS'ning test import formatida
 *     (.txt: "+ to'g'ri", "- noto'g'ri") fayl beradi.
 *  3) Topshiriq yaratish — mavzuni so'raydi, materialdan topshiriq tuzib PDF beradi.
 *  4) "Fanlarim / guruhlarim", "bugungi darslarim".
 * Hech narsa LMS'ga o'zi yozilmaydi: fayl o'qituvchiga beriladi, u ko'rib chiqib yuklaydi. */

export interface TaskFile { name: string; mime: string; base64: string }
export interface TaskAnswer { reply: string; page: string | null; file?: TaskFile }
export type ChatFn = (body: Record<string, unknown>, onDelta?: (text: string) => void) => Promise<string>
interface Turn { role: "user" | "assistant"; content: string }

const norm = (s: string) => s.toLowerCase().replace(/[`´‘’ʻʼ]/g, "'").replace(/\s+/g, " ").trim()
const words = (s: string) => norm(s).replace(/[^\p{L}\p{N}' ]/gu, " ").split(" ").filter(Boolean)
const RESOURCES = "/oqituvchi-kabineti/fan-resurslari"

/* ════════ 1) Talaba ishiga baho tavsiyasi ═════════════════════════════ */

interface SubRow {
  id: number; name: string; title: string; description: string | null; subject: string
  maxScore: number | null; group: string | null; grade: number | null; submittedAt: string
  groupId: number; topicKey: string | null
}

async function teacherSubmissions(teacherId: number): Promise<SubRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT s.id, s.student_full_name, s.grade, s.submitted_at, c.title, c.description, c.subject_name, c.max_score, c.group_id, c.topic_key, g.name AS group_name
     FROM lms_submissions s
     JOIN lms_teacher_content c ON c.id = s.content_id
     LEFT JOIN lms_groups g ON g.id = c.group_id
     WHERE c.teacher_user_id = ? AND c.type = 'assignment'
     ORDER BY s.submitted_at DESC LIMIT 3000`, [teacherId]
  )
  return rows.map((r) => ({
    id: Number(r.id), name: String(r.student_full_name), title: String(r.title), description: r.description ? String(r.description) : null,
    subject: String(r.subject_name), maxScore: r.max_score != null ? Number(r.max_score) : null,
    group: r.group_name ? String(r.group_name) : null, grade: r.grade != null ? Number(r.grade) : null,
    submittedAt: r.submitted_at instanceof Date ? r.submitted_at.toISOString() : String(r.submitted_at),
    groupId: Number(r.group_id), topicKey: r.topic_key ? String(r.topic_key) : null,
  }))
}

/** Xabardagi so'z talaba ismining bo'lagimi: "aliyevning" ~ "ALIYEV" */
function nameHit(messageWords: string[], nameToken: string): boolean {
  const t = nameToken.toLowerCase().replace(/[`´‘’ʻʼ']/g, "")
  if (t.length < 4) return false
  return messageWords.some((w) => { const x = w.replace(/'/g, ""); return x.length >= 4 && (x.startsWith(t) || (x.length >= 5 && t.startsWith(x))) })
}

/** Savol talaba ishini baholash haqidami ("...ning ishini bahola / necha baho berasan / tekshirib ber") */
export function wantsStudentReview(text: string): boolean {
  const t = norm(text)
  return /(necha|qancha|nechchi)\s*(baho|ball)|baho\s*(ber|qo'y|tavsiya)|bahola|tekshir(ib)?\s*(ber|ko'r|chiq)|ko'rib\s*(ber|chiq)|ishini\s*(och|ko'r)/.test(t)
}

export async function reviewStudentWork(teacherId: number, text: string): Promise<TaskAnswer | null> {
  const subs = await teacherSubmissions(teacherId)
  if (!subs.length) return null
  const ws = words(text)
  // Har bir talaba: ismining nechta bo'lagi xabarda uchraydi
  const scored = new Map<string, number>()
  for (const s of subs) {
    if (scored.has(s.name)) continue
    const tokens = s.name.split(/\s+/).filter((t) => !/^(o'g'li|ogli|qizi|qizi\.|ugli)$/i.test(t))
    scored.set(s.name, tokens.filter((tk) => nameHit(ws, tk)).length)
  }
  const best = Math.max(0, ...scored.values())
  if (best === 0) return null // ism topilmadi — bu boshqa turdagi savol
  const names = [...scored.entries()].filter(([, n]) => n === best).map(([name]) => name)
  if (names.length > 1) {
    return { page: "/oqituvchi-kabineti/baholash-page", reply: `Shu ismga mos ${names.length} ta talaba topildi. Qaysi biri?\n${names.slice(0, 8).map((n, i) => `${i + 1}) ${n}`).join("\n")}\nFamiliya va ismini to'liqroq yozing.` }
  }
  const mine = subs.filter((s) => s.name === names[0])
  // Bir nechta ishi bo'lsa: xabarda nomi tilga olingani, bo'lmasa — baholanmagani, bo'lmasa — eng yangisi
  const byTitle = mine.filter((s) => words(s.title).filter((w) => w.length >= 5).some((w) => ws.some((m) => m.startsWith(w.slice(0, 5)))))
  const sub = byTitle[0] ?? mine.find((s) => s.grade === null) ?? mine[0]
  const others = mine.length > 1 ? `\n\nBu talabaning yana ${mine.length - 1} ta ishi bor (${mine.filter((s) => s !== sub).slice(0, 3).map((s) => `«${s.title}»`).join(", ")}). Boshqasini ko'rish uchun topshiriq nomini ham yozing.` : ""

  const head = `${sub.name} — ${sub.group ?? "—"} · ${sub.subject} · «${sub.title}»`
  const extracted = await getSubmissionText(sub.id)
  const wordCount = (extracted.text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length
  if (extracted.source === "none" || wordCount < 25) {
    return { page: "/oqituvchi-kabineti/baholash-page", reply: `${head}\n\nIshni ochdim, lekin matnini o'qib bo'lmadi${wordCount ? ` (faqat ${wordCount} ta so'z chiqdi)` : ""}. Bu qo'lyozma, sifatsiz rasm yoki matnsiz fayl bo'lishi mumkin — baho tavsiya qila olmayman. Faylni «Baholash» sahifasida o'zingiz ochib ko'ring.${others}` }
  }
  let review
  try {
    // Ish topshiriq nomi, mavzu nomi va mavzuga yuklangan material bilan solishtiriladi
    const reference = await loadTopicReference({ groupId: sub.groupId, subjectName: sub.subject, topicKey: sub.topicKey })
      .catch(() => ({ topicTitle: null as string | null, material: "" }))
    review = await reviewText(
      { title: sub.title, description: sub.description, subject: sub.subject, topicTitle: reference.topicTitle, material: reference.material },
      extracted.text, "high")
  } catch (err) {
    if (err instanceof NoTopicError) {
      return {
        page: "/oqituvchi-kabineti/baholash-page",
        reply: `${head}\n\nIshni ochib o'qidim (${wordCount} ta so'z), lekin baho tavsiya qila olmayman: topshiriq nomi va tavsifi mavzuni bildirmaydi, mavzuga taqdimot yoki qo'llanma ham yuklanmagan — ishni nima bilan solishtirishni bilmayman. Topshiriqqa aniq nom yoki tavsif yozing.${others}`,
      }
    }
    return { page: "/oqituvchi-kabineti/baholash-page", reply: `${head}\n\nIshni ochib o'qidim (${wordCount} ta so'z), lekin model hozir javob bermadi. Birozdan keyin qayta so'rang.${others}` }
  }
  const max = sub.maxScore && sub.maxScore > 0 ? sub.maxScore : 100
  const scaled = max === 100 ? "" : ` — topshiriqning maksimal bali ${max} bo'lgani uchun bu taxminan ${Math.round((review.grade ?? 0) * max / 10) / 10} ball`
  const lines = [
    head,
    "",
    extracted.source === "ocr"
      ? `Fayl rasm yoki skaner ekan — matnga aylantirib o'qidim (${wordCount} ta so'z; ayrim harflar xato o'qilgan bo'lishi mumkin).`
      : `Ishni ochib o'qidim (${wordCount} ta so'z).`,
    review.relevance !== null ? `Mavzuga moslik: ${review.relevance}%` : "Mavzuga moslik: baholab bo'lmadi — topshiriq nomi va tavsifi mavzuni aniq bildirmaydi.",
    `Tavsiya baho: 100 dan ${review.grade}${scaled}`,
    review.comment ? `Izoh: ${review.comment}` : "",
    sub.grade !== null ? `Hozir qo'yilgan baho: ${sub.grade}.` : "Hali baholanmagan.",
    "",
    "Bu faqat tavsiya — model xato qilishi mumkin. Bahoni «Baholash» sahifasida o'zingiz qo'yasiz.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "")
  return { page: "/oqituvchi-kabineti/baholash-page", reply: lines.join("\n") + others }
}

/* ════════ 2–3) Test va topshiriq yaratish ═════════════════════════════ */

const ASK_TEST = "Test tuzish uchun"
const ASK_TASK = "Topshiriq tuzish uchun"
type Kind = "test" | "task"

function createKind(text: string): Kind | null {
  const t = norm(text)
  // "test qanday yaratiladi", "topshiriq yaratmoqchiman" — bu saytdan foydalanish savoli, yaratish buyrug'i emas
  if (/(qanday|qayerda|qayerdan|moqchiman)/.test(t) && !/\bber(ing)?\b/.test(t)) return null
  const make = /(tuz|yoz|yarat|tayyorla|ishlab chiq|qil)(ib)?\s*(ber|qo'y)/.test(t) || /\d+\s*ta\s+(test\s+)?(savol|test)/.test(t)
  if (!make) return null
  if (/(topshiri|vazifa|amaliy ish|mustaqil ish)/.test(t) && !/(test|savol)/.test(t)) return "task"
  if (/(test|savol)/.test(t)) return "test"
  return null
}

/** Davom etayotgan so'rov: oxirgi javob "nechta / qaysi mavzu" savoli bo'lsa — oldingi buyruq bilan birga */
function activeRequest(history: Turn[]): { kind: Kind; text: string } | null {
  const cur = history[history.length - 1].content
  const kind = createKind(cur)
  if (kind) return { kind, text: cur }
  const lastBot = [...history].reverse().find((m) => m.role === "assistant")?.content ?? ""
  const pending: Kind | null = lastBot.startsWith(ASK_TEST) ? "test" : lastBot.startsWith(ASK_TASK) ? "task" : null
  if (!pending) return null
  // Buyruq berilgan xabardan boshlab hamma javoblar birga ("test tuzib ber" + "10 ta" + "talab va taklif")
  const users = history.filter((m) => m.role === "user").map((m) => m.content)
  let start = users.length - 1
  for (let i = users.length - 1; i >= Math.max(0, users.length - 5); i--) { start = i; if (createKind(users[i])) break }
  return { kind: pending, text: users.slice(start).join(" . ") }
}

function questionCount(text: string): number | null {
  const m = norm(text).match(/(\d{1,3})\s*(ta|dona|savol|test)/) ?? norm(text).match(/(?:^|[ .])(\d{1,2})(?:$|[ .])/)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 ? Math.min(n, 30) : null
}

interface Found { course: Course; topic: Topic; score: number }

/** Xabarda tilga olingan mavzu: nomidagi so'zlar yoki "3-mavzu" */
function findTopics(courses: Course[], text: string): Found[] {
  const ws = words(text)
  const nth = norm(text).match(/(\d{1,2})\s*-?\s*mavzu/)
  const groupHit = (c: Course) => ws.some((w) => w.length >= 4 && c.groupName.toLowerCase().startsWith(w)) ? 0.5 : 0
  const found: Found[] = []
  for (const course of courses) {
    for (const topic of course.topics) {
      const tw = words(topic.title).filter((w) => w.length >= 4 && !/^(mavzu|amaliy|mashg'ulot|ma'ruza|sinov|test)$/.test(w))
      const hits = tw.filter((w) => ws.some((m) => m.length >= 4 && (m.startsWith(w.slice(0, Math.max(4, w.length - 2))) || w.startsWith(m.slice(0, Math.max(4, m.length - 2)))))).length
      let score = tw.length ? hits / tw.length : 0
      if (hits === 0 && nth && Number(nth[1]) === topic.index) score = 0.6
      if (score >= 0.5) found.push({ course, topic, score: score + groupHit(course) })
    }
  }
  return found.sort((a, b) => b.score - a.score)
}

/** Resurslarda topilmasa — xabarning o'zidan mavzu nomi: «...» yoki "... mavzusidan" */
function freeTopic(text: string): string | null {
  const quoted = text.match(/["«“]([^"»”]{4,120})["»”]/)
  if (quoted) return quoted[1].trim()
  const m = text.match(/([\p{L}\p{N}' ,-]{4,100}?)\s+(?:mavzu(?:si)?(?:dan|da|ga)?|bo'yicha|yuzasidan|haqida|fanidan)(?:\s|$|[.,])/iu)
  if (!m) return null
  const phrase = m[1].replace(/^(menga|iltimos|shu|ushbu|quyidagi|.*?\b(ber|tuz|yarat|yoz)\w*)\s+/i, "").replace(/\b\d+\s*ta\b/g, "").trim()
  return phrase.length >= 4 && !/^(test|savol|topshiriq)$/i.test(phrase) ? phrase : null
}

const materialCache = new Map<string, string>()
const DOC = /\.(pdf|ppt|pptx|doc|docx|odp|odt|txt|rtf)$/i

/** Mavzuning taqdimot / qo'llanma va boshqa hujjatlaridan matn (rasm-skaner bo'lsa OCR bilan) */
async function topicMaterial(topic: Topic): Promise<{ text: string; files: string[] }> {
  const items = topic.group.filter((c: TeacherContentRecord) => c.type === "mavzu" && ["theory", "qollanma"].includes(c.kind ?? ""))
  const files = items.flatMap((c) => (c.files.length ? c.files : c.file ? [c.file] : [])).filter((f) => DOC.test(f.originalName)).slice(0, 3)
  const parts: string[] = []
  const used: string[] = []
  for (const f of files) {
    const key = `${f.relativePath}|${f.size}`
    let text = materialCache.get(key)
    if (text === undefined) {
      const abs = storedFilePath(privateStorageRoot(), f.relativePath)
      text = abs && fs.existsSync(abs) ? (await extractFileText(abs, f.originalName)).text.replace(/\s+/g, " ").trim() : "" // nosemgrep — server yaratgan yo'l
      if (materialCache.size > 200) materialCache.clear()
      materialCache.set(key, text)
    }
    if (text.length > 150) { parts.push(text); used.push(f.originalName) }
  }
  return { text: parts.join("\n\n"), files: used }
}

/** Model uchun material: boshidan, o'rtasidan va oxiridan — jami ~3600 belgi (protsessorda o'qish sekin) */
function excerpt(text: string, limit = 3600): string {
  if (text.length <= limit) return text
  const part = Math.floor(limit / 3)
  const mid = Math.floor(text.length / 2 - part / 2)
  return `${text.slice(0, part)} … ${text.slice(mid, mid + part)} … ${text.slice(-part)}`
}

function topicList(courses: Course[]): string {
  const lines: string[] = []
  for (const c of courses.slice(0, 4)) {
    lines.push(`${c.groupName} · ${c.subjectName}:`)
    for (const t of c.topics.slice(0, 8)) lines.push(`   ${t.index}) ${t.title}`)
    if (c.topics.length > 8) lines.push(`   … yana ${c.topics.length - 8} ta`)
  }
  return lines.join("\n")
}

/** Model yozgan matndan yaroqli savollar (test import formati: "+ to'g'ri", "- noto'g'ri") */
function parseQuestions(raw: string): Array<{ q: string; options: string[]; correct: number }> {
  const out: Array<{ q: string; options: string[]; correct: number }> = []
  let cur: { q: string; options: string[]; correct: number } | null = null
  const push = () => {
    if (cur && cur.q.length > 5 && cur.options.length >= 3 && cur.correct >= 0 && new Set(cur.options.map(norm)).size === cur.options.length
      && !out.some((o) => norm(o.q) === norm(cur!.q))) out.push(cur)
    cur = null
  }
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.replace(/\*\*/g, "").trim()
    if (!line) continue
    const opt = line.match(/^([+\-–—])\s*(.+)$/)
    if (opt && cur) {
      const textOpt = opt[2].replace(/^[A-Da-d][).]\s*/, "").trim()
      if (opt[1] === "+" && cur.correct < 0) cur.correct = cur.options.length
      else if (opt[1] === "+") continue // ikkinchi "+" — tashlab yuboriladi
      cur.options.push(textOpt)
      continue
    }
    const q = line.match(/^(\d{1,3})\s*[.)]\s*(.+)$/)
    if (q) { push(); cur = { q: q[2].trim(), options: [], correct: -1 } }
  }
  push()
  return out
}

async function buildTest(chat: ChatFn, topicTitle: string, subject: string, material: string, count: number, onDelta?: (t: string) => void) {
  const system = [
    "Sen oliy ta'lim o'qituvchisi uchun test tuzasan. Faqat quyidagi QAT'IY formatda yoz, boshqa hech narsa yozma:",
    "",
    "1. Savol matni?",
    "+ to'g'ri javob",
    "- noto'g'ri javob",
    "- noto'g'ri javob",
    "- noto'g'ri javob",
    "",
    "Qoidalar: har savolda aynan 4 ta variant, faqat bittasi \"+\" bilan. To'g'ri javobni har safar boshqa o'ringa qo'y. Variantlar har xil va qisqa bo'lsin. Savollar bir-birini takrorlamasin.",
    material ? "Savollarni FAQAT berilgan dars materialidan tuz — materialda yo'q narsani so'rama." : "Savollar mavzuga oid va faktik jihatdan to'g'ri bo'lsin; aniq bilmagan narsangni so'rama.",
    "O'zbek tilida, lotin yozuvida yoz.",
  ].join("\n")
  const user = [`Fan: ${subject}`, `Mavzu: ${topicTitle}`, `Savollar soni: ${count}`, material ? `\nDARS MATERIALI:\n${excerpt(material)}` : ""].join("\n")
  // Model ba'zan kamroq yoki yaroqsiz savol yozadi — ikki urinishgacha
  const valid: Array<{ q: string; options: string[]; correct: number }> = []
  for (let attempt = 0; attempt < 2 && valid.length < count; attempt++) {
    const need = count - valid.length
    const raw = await chat({
      messages: [{ role: "system", content: system }, { role: "user", content: attempt === 0 ? user : `${user}\n\nYana ${need} ta YANGI savol yoz (oldingilarini takrorlama).` }],
      options: { temperature: 0.5, num_ctx: 4096, num_predict: Math.min(2600, need * 95 + 120), repeat_penalty: 1.15 },
    }, attempt === 0 ? onDelta : undefined)
    for (const q of parseQuestions(raw)) if (valid.length < count && !valid.some((v) => norm(v.q) === norm(q.q))) valid.push(q)
  }
  return valid
}

function testFileText(questions: Array<{ q: string; options: string[]; correct: number }>): string {
  const head = ["ball: 100", `vaqt: ${Math.max(10, Math.round(questions.length * 1.5))}`, "urinish: 2", `test soni: ${questions.length}`, ""]
  const body = questions.flatMap((q, i) => [`${i + 1}. ${q.q}`, ...q.options.map((o, j) => `${j === q.correct ? "+" : "-"} ${o}`), ""])
  return [...head, ...body].join("\r\n")
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const slug = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "mavzu"

/** Topshiriq matnidan PDF (LibreOffice); bo'lmasa — null */
async function taskPdf(title: string, subject: string, body: string): Promise<Buffer | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-task-"))
  try {
    const html = path.join(dir, "topshiriq.html")
    const paragraphs = body.split(/\n/).map((l) => {
      const line = l.trim()
      if (!line) return ""
      return /^[\p{Lu}][^.!?]{2,60}:$/u.test(line) ? `<h3>${esc(line)}</h3>` : `<p>${esc(line)}</p>`
    }).join("\n")
    fs.writeFileSync(html, `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{font-family:"Times New Roman",serif;font-size:13pt;line-height:1.45}
      h1{font-size:16pt;text-align:center;margin:0 0 4pt} .sub{text-align:center;color:#444;margin:0 0 14pt}
      h3{font-size:13pt;margin:12pt 0 4pt} p{margin:0 0 6pt;text-align:justify}
    </style></head><body><h1>${esc(title)}</h1><p class="sub">${esc(subject)}</p>${paragraphs}</body></html>`, "utf8")
    const out = path.join(dir, `${crypto.randomUUID()}.pdf`)
    for (const format of ["pdf:writer_web_pdf_Export", "pdf"]) {
      if (await convertWithLibreOffice(html, format, out, 60_000)) {
        const pdf = fs.readFileSync(out)
        if (pdf.length > 800) return pdf
      }
    }
    return null
  } catch {
    return null
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => undefined)
  }
}

async function buildTask(chat: ChatFn, topicTitle: string, subject: string, material: string, onDelta?: (t: string) => void): Promise<string> {
  const system = [
    "Sen oliy ta'lim muassasasida ishlaydigan tajribali o'qituvchi-metodistsan. Berilgan mavzu bo'yicha talabalar uchun amaliy topshiriq tuz.",
    "Aynan shu bo'limlar bilan yoz (har bo'lim nomi alohida qatorda, ikki nuqta bilan):",
    "Maqsad:\nTopshiriq sharti:\nBajarish tartibi:\nTopshirish shakli:\nBaholash mezoni:",
    "Topshiriq sharti aniq va bajarsa bo'ladigan bo'lsin (3–5 ta band). Baholash mezonida ballar jami 100 bo'lsin.",
    material ? "Topshiriqni FAQAT berilgan dars materialiga tayanib tuz — undagi tushuncha va misollardan foydalan." : "Aniq bilmagan fakt yoki sonni yozma.",
    "O'zbek tilida, lotin yozuvida. Markdown ishlatma (yulduzcha, panjara yo'q). Sarlavha yozma — faqat bo'limlar.",
  ].join("\n")
  const user = [`Fan: ${subject}`, `Mavzu: ${topicTitle}`, material ? `\nDARS MATERIALI:\n${excerpt(material)}` : ""].join("\n")
  const raw = await chat({
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    options: { temperature: 0.4, num_ctx: 4096, num_predict: 900, repeat_penalty: 1.1 },
  }, onDelta)
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").replace(/\n{3,}/g, "\n\n").trim()
}

/** Test / topshiriq yaratish suhbati. Bu shunday so'rov bo'lmasa — null */
export async function createMaterialFlow(history: Turn[], teacherId: number | undefined, chat: ChatFn, onDelta?: (t: string) => void): Promise<TaskAnswer | null> {
  const req = activeRequest(history)
  if (!req) return null
  const courses = teacherId ? await loadCourses(teacherId).catch(() => [] as Course[]) : []
  const ask = req.kind === "test" ? ASK_TEST : ASK_TASK
  const count = req.kind === "test" ? questionCount(req.text) : 1

  const found = findTopics(courses, req.text)
  const free = found.length ? null : freeTopic(req.text)
  // Bir nechta mavzu bir xil darajada mos kelsa — qaysi biri ekanini so'raydi
  const tied = found.filter((f) => f.score === found[0].score)
  const sameTopic = tied.every((f) => norm(f.topic.title) === norm(tied[0].topic.title))

  if (!found.length && !free) {
    const list = courses.length ? `\n\nSizning mavzularingiz:\n${topicList(courses)}` : ""
    return { page: RESOURCES, reply: `${ask} qaysi mavzu ekanini ayting${req.kind === "test" && !count ? " va nechta savol kerakligini ham" : ""}. Mavzu nomini yoki raqamini yozing (masalan: "3-mavzu").${list}` }
  }
  if (found.length && tied.length > 1 && !sameTopic) {
    return { page: RESOURCES, reply: `${ask} mavzuni aniqlashtiring — bir nechtasi mos keldi:\n${tied.slice(0, 6).map((f, i) => `${i + 1}) ${f.course.groupName} · ${f.topic.index}-mavzu «${f.topic.title}»`).join("\n")}\nMavzu nomini to'liqroq yozing.` }
  }
  if (req.kind === "test" && !count) {
    return { page: RESOURCES, reply: `${ask} nechta savol kerak? (masalan: 10 ta)` }
  }

  const topicTitle = found.length ? found[0].topic.title : free!
  const subject = found.length ? found[0].course.subjectName : (courses[0]?.subjectName ?? "")
  const material = found.length ? await topicMaterial(found[0].topic).catch(() => ({ text: "", files: [] as string[] })) : { text: "", files: [] as string[] }
  const basis = material.files.length
    ? `Manba: mavzuga yuklangan ${material.files.map((f) => `"${f}"`).join(", ")}.`
    : found.length
      ? "Bu mavzuda o'qiladigan taqdimot yoki qo'llanma topilmadi — umumiy bilim asosida tuzildi, sinchiklab tekshiring."
      : "Bu mavzu resurslaringizda topilmadi — umumiy bilim asosida tuzildi, sinchiklab tekshiring."

  if (req.kind === "test") {
    const questions = await buildTest(chat, topicTitle, subject, material.text, count!, onDelta)
    if (!questions.length) return { page: RESOURCES, reply: "Test tuza olmadim — model yaroqli savol yozmadi. Qayta urinib ko'ring yoki savollar sonini kamaytiring." }
    const preview = questions.slice(0, 2).map((q, i) => `${i + 1}. ${q.q}\n${q.options.map((o, j) => `${j === q.correct ? "+" : "-"} ${o}`).join("\n")}`).join("\n\n")
    const short = questions.length < count! ? ` (so'ralgan ${count} tadan — qolganlari yaroqsiz chiqdi)` : ""
    return {
      page: RESOURCES,
      reply: `«${topicTitle}» mavzusidan ${questions.length} ta savolli test tayyor${short}.\n${basis}\n\nNamuna:\n${preview}\n\nFaylni yuklab oling, savollar va to'g'ri javoblarni tekshiring, keyin «Mavzu va resurslar» sahifasida mavzuning Test bo'limiga sudrab tashlang — savollar o'zi yuklanadi.`,
      file: { name: `Test - ${slug(topicTitle)}.txt`, mime: "text/plain; charset=utf-8", base64: Buffer.from("﻿" + testFileText(questions), "utf8").toString("base64") },
    }
  }

  const body = await buildTask(chat, topicTitle, subject, material.text, onDelta)
  if (body.length < 80) return { page: RESOURCES, reply: "Topshiriq tuza olmadim — model javob bermadi. Qayta urinib ko'ring." }
  const title = `Amaliy topshiriq: ${topicTitle}`
  const pdf = await taskPdf(title, subject, body)
  const file: TaskFile = pdf
    ? { name: `Topshiriq - ${slug(topicTitle)}.pdf`, mime: "application/pdf", base64: pdf.toString("base64") }
    : { name: `Topshiriq - ${slug(topicTitle)}.txt`, mime: "text/plain; charset=utf-8", base64: Buffer.from(`﻿${title}\r\n${subject}\r\n\r\n${body.replace(/\n/g, "\r\n")}`, "utf8").toString("base64") }
  return {
    page: RESOURCES,
    reply: `«${topicTitle}» mavzusidan topshiriq tayyor.\n${basis}\n\n${body}\n\n${pdf ? "PDF faylni" : "Faylni (PDF qilib bo'lmadi, matn ko'rinishida)"} yuklab oling, ko'rib chiqing va «Mavzu va resurslar» sahifasida mavzuning Topshiriq bo'limiga biriktiring.`,
    file,
  }
}

/* ════════ 4) Shaxsiy ma'lumot: fanlarim, guruhlarim, bugungi darslar ══ */

export function personalQuestion(text: string): "courses" | "today" | "tomorrow" | null {
  const t = norm(text)
  if (/(bugun|bugungi).*(dars|mashg'ulot|para|jadval)|(dars|mashg'ulot|para)\w*.*bugun/.test(t)) return "today"
  if (/(ertaga|ertangi).*(dars|mashg'ulot|para|jadval)/.test(t)) return "tomorrow"
  if (/(mening|meni|o'zimning)?\s*(fanlarim|guruhlarim)|(qaysi|nechta|qancha)\s*(fan|guruh)\w*\s*(bor|o'taman|dars beraman|biriktirilgan)|(fan|guruh)larimni\s*(ko'rsat|ayt|chiqar)/.test(t)) return "courses"
  return null
}

export async function personalAnswer(kind: "courses" | "today" | "tomorrow", teacherId: number): Promise<TaskAnswer> {
  if (kind === "courses") {
    const courses = await loadCourses(teacherId)
    if (!courses.length) return { page: RESOURCES, reply: "LMS'da siz hali mavzu yaratmagan fan-guruh topilmadi. Guruhlaringiz HEMIS'dan olinadi; mavzu qo'shish uchun «Mavzu va resurslar» sahifasiga o'ting." }
    const bySubject = new Map<string, Course[]>()
    for (const c of courses) bySubject.set(c.subjectName, [...(bySubject.get(c.subjectName) ?? []), c])
    const lines = [...bySubject.entries()].map(([subject, list], i) => `${i + 1}) ${subject} — ${list.map((c) => `${c.groupName.split(" ")[0]} (${c.topics.length} ta mavzu)`).join(", ")}`)
    return { page: RESOURCES, reply: `Siz mavzu yaratgan fanlar: ${bySubject.size} ta, guruhlar: ${new Set(courses.map((c) => c.groupId)).size} ta.\n\n${lines.join("\n")}\n\nBu ro'yxat LMS'da kontent yaratgan fan-guruhlaringiz; HEMIS'dagi to'liq yuklamangiz «Dars jadvali» sahifasida.` }
  }
  const day = new Date()
  if (kind === "tomorrow") day.setDate(day.getDate() + 1)
  const p = (n: number) => String(n).padStart(2, "0")
  const iso = `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`
  const lessons = (await getTeacherSchedule(teacherId)).filter((l) => l.lessonDate === iso)
  const label = kind === "today" ? "Bugun" : "Ertaga"
  if (!lessons.length) return { page: "/xodim/dars-jadvali", reply: `${label} (${p(day.getDate())}.${p(day.getMonth() + 1)}) jadvalingizda dars topilmadi. Jadval HEMIS'dan olinadi — to'liq ko'rish uchun «Dars jadvali» sahifasini oching.` }
  const groupIds = [...new Set(lessons.map((l) => l.groupId).filter((g): g is number => g != null))]
  const names = new Map<number, string>()
  if (groupIds.length) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id, name FROM lms_groups WHERE id IN (?)", [groupIds])
    for (const r of rows) names.set(Number(r.id), String(r.name))
  }
  const lines = lessons.map((l, i) => `${i + 1}) ${String(l.startTime ?? "").slice(0, 5)}–${String(l.endTime ?? "").slice(0, 5)} · ${l.subjectName} · ${l.groupId != null ? names.get(l.groupId) ?? `guruh #${l.groupId}` : "—"}${l.room ? ` · ${l.room}-xona` : ""}`)
  return { page: "/xodim/dars-jadvali", reply: `${label} ${lessons.length} ta darsingiz bor:\n\n${lines.join("\n")}` }
}
