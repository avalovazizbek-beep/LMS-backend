import axios from "axios"
import type mysql from "mysql2/promise"
import { pool } from "./db"
import type { SubmissionRecord, TeacherContentRecord } from "./teachingStore"
import { getSubmissionText, type TextSource } from "./submissionText"
import { getAiReviews, queueAiReviews, type AiReview } from "./submissionAiReview"

/* ── Antiplagiat ─────────────────────────────────────────────────────────
 * 1) Har bir ishning matni (services/submissionText.ts): oddiy fayldan
 *    to'g'ridan-to'g'ri, rasm / skaner / qo'lyozma rasmidan — OCR orqali.
 *    Fonda oldindan tayyorlanadi, shuning uchun tugma bosilganda tez.
 * 2) O'zaro solishtirish: shu topshiriqdagi ishlar + shu o'qituvchining
 *    boshqa guruhlarga tarqatilgan AYNAN shu topshirig'idagi ishlar.
 * 3) Internet (ixtiyoriy, Google kaliti bo'lsa).
 * 4) AI tavsiya (services/submissionAiReview.ts): mavzuga moslik va
 *    100 ballik tavsiya baho — fonda, navbat bilan. ─────────────────── */

/* ── N-gram shingling + Jaccard o'xshashligi ───────────────────────── */
const SHINGLE_SIZE = 6
// Rasmdan o'qilgan (OCR) matnda harflar xato chiqadi — 6 so'zli ketma-ketlik
// deyarli hech qachon aynan mos kelmaydi. Shuning uchun OCR ishtirok etgan
// juftlikda qisqaroq (3 so'zli) bo'laklar solishtiriladi.
const OCR_SHINGLE_SIZE = 3
const MIN_WORDS_FOR_COMPARISON = 30 // qisqa/umumiy izohlar tasodifiy "o'xshash" chiqib ketmasin

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[`´‘’ʻʼ']/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()
}

function buildShingles(words: string[], size: number): Set<string> {
  if (words.length < MIN_WORDS_FOR_COMPARISON) return new Set()
  const set = new Set<string>()
  for (let i = 0; i + size <= words.length; i++) set.add(words.slice(i, i + size).join(" "))
  return set
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  let inter = 0
  for (const x of small) if (large.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

interface Doc {
  submissionId: number
  studentName: string
  /** Boshqa guruhdagi ish bo'lsa — guruh nomi */
  groupName: string | null
  source: TextSource
  words: number
  long: Set<string>
  short: Set<string>
}

function toDoc(submissionId: number, studentName: string, groupName: string | null, text: string, source: TextSource): Doc {
  const words = normalizeText(text).split(" ").filter(Boolean)
  return {
    submissionId, studentName, groupName, source, words: words.length,
    long: buildShingles(words, SHINGLE_SIZE), short: buildShingles(words, OCR_SHINGLE_SIZE),
  }
}

function similarity(a: Doc, b: Doc): number {
  return a.source === "ocr" || b.source === "ocr" ? jaccardSimilarity(a.short, b.short) : jaccardSimilarity(a.long, b.long)
}

/* ── Internet orqali tekshirish — Google Custom Search JSON API ─────────
   Faqat GOOGLE_CSE_KEY va GOOGLE_CSE_CX (.env) sozlangan bo'lsa ishlaydi.
   Sozlanmagan bo'lsa xato ko'rsatilmaydi — shunchaki "enabled: false"
   qaytariladi va admin/o'qituvchiga shu holat ochiq ko'rsatiladi (soxta
   natija chiqarilmaydi). Kvota tejash uchun har topshiriqdan faqat bir
   necha eng uzun, o'ziga xos jumla qidiriladi. */
export interface InternetMatch { sentence: string; title: string; link: string; snippet: string }

/** Matndan qidirish uchun bir nechta eng uzun, o'ziga xos jumla */
function pickSentences(text: string, count: number): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(s => s.split(" ").length >= 8)
    .sort((a, b) => b.length - a.length)
    .slice(0, count)
}

/* ── Wikipedia (bepul, kalitsiz) ─────────────────────────────────────────
   Google Custom Search yangi loyihalarga berilmay qo'ygan ("This project does
   not have the access to Custom Search JSON API", 2026-11-11). Wikipedia'ning
   rasmiy qidiruv API'si kalit ham, kunlik limit ham talab qilmaydi va talabalar
   eng ko'p ko'chiradigan manbalardan biri. Har jumladan 9 so'zli ibora aynan
   (qo'shtirnoq ichida) qidiriladi. O'chirish: PLAGIARISM_WIKIPEDIA=0 */
const WIKI_ENABLED = process.env.PLAGIARISM_WIKIPEDIA !== "0"
const WIKI_PHRASE_WORDS = 9

async function checkWikipedia(text: string): Promise<{ ok: boolean; matches: InternetMatch[] }> {
  const matches: InternetMatch[] = []
  let ok = false
  for (const sentence of pickSentences(text, 4)) {
    const words = sentence.replace(/["«»“”]/g, "").split(" ")
    // Jumla o'rtasidan (boshi ko'pincha umumiy kirish so'zlari)
    const start = Math.max(0, Math.floor((words.length - WIKI_PHRASE_WORDS) / 2))
    const phrase = words.slice(start, start + WIKI_PHRASE_WORDS).join(" ")
    // Kirill yozuvi — ruscha va o'zbekcha; lotin — o'zbekcha va inglizcha Wikipedia
    const langs = /[Ѐ-ӿ]/.test(phrase) ? ["ru", "uz"] : ["uz", "en"]
    for (const lang of langs) {
      try {
        const res = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
          params: { action: "query", list: "search", srsearch: `"${phrase}"`, srlimit: 2, srprop: "snippet", format: "json" },
          headers: { "User-Agent": "LMS-antiplagiat/1.0" },
          timeout: 8000,
        })
        ok = true
        const items: unknown[] = Array.isArray(res.data?.query?.search) ? res.data.query.search : []
        for (const item of items) {
          const r = item as Record<string, unknown>
          const title = typeof r.title === "string" ? r.title : ""
          if (!title) continue
          matches.push({
            sentence,
            title: `Wikipedia: ${title}`,
            link: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
            snippet: typeof r.snippet === "string" ? r.snippet.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&") : "",
          })
        }
        if (items.length) break // shu jumla topildi — boshqa tilda qidirish shart emas
      } catch { /* tarmoq xatosi — keyingisi */ }
    }
  }
  return { ok, matches }
}

export async function checkInternet(text: string): Promise<{ enabled: boolean; matches: InternetMatch[] }> {
  if (!text.trim()) return { enabled: false, matches: [] }
  const [wiki, google] = await Promise.all([
    WIKI_ENABLED ? checkWikipedia(text) : Promise.resolve({ ok: false, matches: [] as InternetMatch[] }),
    checkGoogle(text),
  ])
  // Bir xil havola ikki marta chiqmasin
  const seen = new Set<string>()
  const matches = [...google.matches, ...wiki.matches].filter((m) => (seen.has(m.link) ? false : (seen.add(m.link), true)))
  return { enabled: wiki.ok || google.enabled, matches }
}

async function checkGoogle(text: string): Promise<{ enabled: boolean; matches: InternetMatch[] }> {
  const key = process.env.GOOGLE_CSE_KEY
  const cx = process.env.GOOGLE_CSE_CX
  if (!key || !cx) return { enabled: false, matches: [] }

  const sentences = pickSentences(text, 3)
  let answered = false

  const matches: InternetMatch[] = []
  for (const sentence of sentences) {
    try {
      const res = await axios.get("https://www.googleapis.com/customsearch/v1", {
        params: { key, cx, q: `"${sentence.slice(0, 300)}"` },
        timeout: 8000,
      })
      answered = true
      const items: unknown[] = Array.isArray(res.data?.items) ? res.data.items : []
      for (const item of items.slice(0, 2)) {
        const r = item as Record<string, unknown>
        matches.push({
          sentence,
          title: typeof r.title === "string" ? r.title : "",
          link: typeof r.link === "string" ? r.link : "",
          snippet: typeof r.snippet === "string" ? r.snippet : "",
        })
      }
    } catch { /* bitta jumla so'rovi xato bo'lsa ham qolganlari davom etadi */ }
  }
  // Kalit bor, lekin Google hamma so'rovni rad etsa (ruxsat yo'q / limit tugagan) —
  // "tekshirildi, topilmadi" deb ko'rsatilmaydi
  return { enabled: answered || sentences.length === 0, matches }
}

export interface PlagiarismResult {
  submissionId: number
  studentUserId: number
  studentFullName: string
  maxSimilarityPct: number
  matchedSubmissionId: number | null
  matchedStudentName: string | null
  /** Eng o'xshash ish boshqa guruhda bo'lsa — o'sha guruh nomi */
  matchedGroupName: string | null
  /** Matn qayerdan olindi: "text" — fayldan, "ocr" — rasm/skanerdan o'qildi, "none" — o'qib bo'lmadi */
  textSource: TextSource
  wordCount: number
  internetEnabled: boolean
  internetMatches: InternetMatch[]
  checkedAt: string
  /** AI tavsiya (mavzuga moslik, 100 ballik tavsiya baho) — fonda tayyorlanadi */
  ai: AiReview | null
}

/** Shu o'qituvchining boshqa guruhlarga tarqatilgan AYNAN shu topshirig'idagi ishlar
    (faqat matni allaqachon tayyorlanganlari — fondagi ishchi tayyorlab turadi) */
async function siblingDocs(content: TeacherContentRecord): Promise<Doc[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT s.id, s.student_full_name, s.extracted_text, s.text_source, g.name AS group_name
     FROM lms_submissions s
     JOIN lms_teacher_content c ON c.id = s.content_id
     LEFT JOIN lms_groups g ON g.id = c.group_id
     WHERE c.id <> ? AND c.teacher_user_id = ? AND c.type = ? AND c.title = ? AND c.subject_name = ?
       AND s.extracted_text IS NOT NULL AND s.extracted_text <> ''
     ORDER BY s.id DESC LIMIT 600`,
    [content.id, content.teacherUserId, content.type, content.title, content.subjectName]
  )
  return rows.map((r) => toDoc(
    Number(r.id), String(r.student_full_name), r.group_name ? String(r.group_name) : null,
    String(r.extracted_text), (r.text_source as TextSource) ?? "text"
  ))
}

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  return out
}

/** Berilgan topshiriq bo'yicha barcha ishlarni o'zaro (va boshqa guruhlardagi
    shu topshiriq ishlari bilan) solishtiradi, (sozlangan bo'lsa) internetdan
    qidiradi, natijani keshlaydi va AI tavsiyani fonda navbatga qo'yadi. */
export async function runPlagiarismCheck(content: TeacherContentRecord, submissions: SubmissionRecord[]): Promise<PlagiarismResult[]> {
  // Matnlar: odatda keshdan (fonda tayyorlangan); yangi ish bo'lsa — shu yerda o'qiladi
  const texts = await inChunks(submissions, 4, async (sub) => ({ sub, ...(await getSubmissionText(sub.id)) }))
  const docs = new Map<number, Doc>()
  for (const t of texts) docs.set(t.sub.id, toDoc(t.sub.id, t.sub.studentFullName, null, t.text, t.source))
  const others = await siblingDocs(content)

  const internet = await inChunks(texts, 5, (t) => checkInternet(t.text))

  const results: PlagiarismResult[] = []
  for (const [index, { sub }] of texts.entries()) {
    const mine = docs.get(sub.id)!
    let best = 0
    let bestDoc: Doc | null = null
    for (const other of [...docs.values(), ...others]) {
      if (other.submissionId === sub.id) continue
      const sim = similarity(mine, other)
      if (sim > best) { best = sim; bestDoc = other }
    }
    const maxSimilarityPct = Math.round(best * 1000) / 10
    const net = internet[index]

    results.push({
      submissionId: sub.id,
      studentUserId: sub.studentUserId,
      studentFullName: sub.studentFullName,
      maxSimilarityPct,
      matchedSubmissionId: bestDoc?.submissionId ?? null,
      matchedStudentName: bestDoc?.studentName ?? null,
      matchedGroupName: bestDoc?.groupName ?? null,
      textSource: mine.source,
      wordCount: mine.words,
      internetEnabled: net.enabled,
      internetMatches: net.matches,
      checkedAt: new Date().toISOString(),
      ai: null,
    })

    await pool.query(
      `INSERT INTO lms_plagiarism_checks
         (content_id, submission_id, student_user_id, student_full_name, max_similarity_pct,
          matched_submission_id, matched_student_name, matched_group_name, text_source, word_count,
          internet_enabled, internet_matches)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         student_full_name     = VALUES(student_full_name),
         max_similarity_pct    = VALUES(max_similarity_pct),
         matched_submission_id = VALUES(matched_submission_id),
         matched_student_name  = VALUES(matched_student_name),
         matched_group_name    = VALUES(matched_group_name),
         text_source           = VALUES(text_source),
         word_count            = VALUES(word_count),
         internet_enabled      = VALUES(internet_enabled),
         internet_matches      = VALUES(internet_matches),
         checked_at            = CURRENT_TIMESTAMP`,
      [
        content.id, sub.id, sub.studentUserId, sub.studentFullName, maxSimilarityPct,
        bestDoc?.submissionId ?? null, bestDoc?.studentName ?? null, bestDoc?.groupName ?? null, mine.source, mine.words,
        net.enabled ? 1 : 0, JSON.stringify(net.matches),
      ]
    )
  }

  // AI tavsiya — fonda (kutilmaydi); natijalar tayyor bo'lgani sari ko'rinadi
  await queueAiReviews(content, texts.map((t) => ({ submissionId: t.sub.id, text: t.text })))
    .catch((err) => console.warn("[ai-tavsiya] navbatga qo'yilmadi:", err instanceof Error ? err.message : err))
  const ai = await getAiReviews(content.id)
  return results.map((r) => ({ ...r, ai: ai.get(r.submissionId) ?? null }))
}

export async function getCachedPlagiarismResults(contentId: number): Promise<PlagiarismResult[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_plagiarism_checks WHERE content_id = ? ORDER BY max_similarity_pct DESC",
    [contentId]
  )
  const ai = await getAiReviews(contentId)
  return rows.map((r) => ({
    submissionId: Number(r.submission_id),
    studentUserId: Number(r.student_user_id),
    studentFullName: String(r.student_full_name),
    maxSimilarityPct: Number(r.max_similarity_pct),
    matchedSubmissionId: r.matched_submission_id != null ? Number(r.matched_submission_id) : null,
    matchedStudentName: r.matched_student_name ?? null,
    matchedGroupName: r.matched_group_name ?? null,
    textSource: (r.text_source as TextSource) ?? "text",
    wordCount: r.word_count != null ? Number(r.word_count) : 0,
    internetEnabled: Boolean(r.internet_enabled),
    internetMatches: r.internet_matches
      ? (typeof r.internet_matches === "string" ? JSON.parse(r.internet_matches) : r.internet_matches)
      : [],
    checkedAt: String(r.checked_at),
    ai: ai.get(Number(r.submission_id)) ?? null,
  }))
}
