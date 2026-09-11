import path from "path"
import os from "os"
import fs from "fs"
import { execFile } from "child_process"
import axios from "axios"
import type mysql from "mysql2/promise"
import { pool } from "./db"
import { privateStorageRoot, type SubmissionRecord } from "./teachingStore"

/* ── Fayldan matn ajratib olish — mavjud "pptx-as-pdf" yo'lidagi bilan bir
   xil, allaqachon serverga o'rnatilgan LibreOffice (soffice) orqali ────── */
const LO_CANDIDATES = process.platform === "win32"
  ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "soffice"]
  : ["libreoffice", "soffice"]

// .doc eski (binary) format ham LibreOffice orqali ochiladi
const LO_EXTRACTABLE_EXT = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".pdf"])

function convertToText(absPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const cacheDir = path.join(os.tmpdir(), "lms-plagiarism-txt")
    fs.mkdirSync(cacheDir, { recursive: true })
    let tried = 0
    function tryNext() {
      if (tried >= LO_CANDIDATES.length) { resolve(null); return }
      const bin = LO_CANDIDATES[tried++]
      execFile(bin, ["--headless", "--convert-to", "txt:Text", "--outdir", cacheDir, absPath], { timeout: 45000 }, (err) => {
        if (err) { tryNext(); return }
        const auto = path.join(cacheDir, path.basename(absPath, path.extname(absPath)) + ".txt")
        if (!fs.existsSync(auto)) { tryNext(); return }
        let text: string | null = null
        try { text = fs.readFileSync(auto, "utf-8") } catch { text = null }
        fs.rm(auto, { force: true }, () => undefined)
        resolve(text)
      })
    }
    tryNext()
  })
}

function stripRtf(raw: string): string {
  return raw.replace(/\\[a-z]+-?\d*/gi, " ").replace(/[{}]/g, " ").replace(/\s+/g, " ").trim()
}

/** Topshiriqning izohi + (agar bo'lsa) faylidan matn ajratib oladi. Fayl matni
    LibreOffice orqali ajratiladi (.txt/.rtf to'g'ridan-to'g'ri o'qiladi). */
export async function extractSubmissionText(sub: SubmissionRecord): Promise<string> {
  const parts: string[] = []
  if (sub.comment?.trim()) parts.push(sub.comment.trim())
  if (sub.file) {
    const ext = path.extname(sub.file.originalName).toLowerCase()
    const absPath = path.join(privateStorageRoot(), sub.file.relativePath.replace(/^\/+/, ""))
    if (fs.existsSync(absPath)) {
      if (ext === ".txt") {
        try { parts.push(fs.readFileSync(absPath, "utf-8")) } catch { /* ignore */ }
      } else if (ext === ".rtf") {
        try { parts.push(stripRtf(fs.readFileSync(absPath, "utf-8"))) } catch { /* ignore */ }
      } else if (LO_EXTRACTABLE_EXT.has(ext)) {
        const text = await convertToText(absPath)
        if (text) parts.push(text)
      }
    }
  }
  return parts.join("\n\n").trim()
}

/* ── N-gram shingling + Jaccard o'xshashligi — talaba-talaba solishtirish ── */
const SHINGLE_SIZE = 6
const MIN_WORDS_FOR_COMPARISON = 30 // qisqa/umumiy izohlar tasodifiy "o'xshash" chiqib ketmasin

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim()
}

function buildShingles(normalized: string): Set<string> {
  const words = normalized.split(" ").filter(Boolean)
  if (words.length < MIN_WORDS_FOR_COMPARISON) return new Set()
  const set = new Set<string>()
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) set.add(words.slice(i, i + SHINGLE_SIZE).join(" "))
  return set
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/* ── Internet orqali tekshirish — Google Custom Search JSON API ─────────
   Faqat GOOGLE_CSE_KEY va GOOGLE_CSE_CX (.env) sozlangan bo'lsa ishlaydi.
   Sozlanmagan bo'lsa xato ko'rsatilmaydi — shunchaki "enabled: false"
   qaytariladi va admin/o'qituvchiga shu holat ochiq ko'rsatiladi (soxta
   natija chiqarilmaydi). Kvota tejash uchun har topshiriqdan faqat bir
   necha eng uzun, o'ziga xos jumla qidiriladi. */
export interface InternetMatch { sentence: string; title: string; link: string; snippet: string }

export async function checkInternet(text: string): Promise<{ enabled: boolean; matches: InternetMatch[] }> {
  const key = process.env.GOOGLE_CSE_KEY
  const cx = process.env.GOOGLE_CSE_CX
  if (!key || !cx || !text.trim()) return { enabled: false, matches: [] }

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.split(/\s+/).length >= 8)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)

  const matches: InternetMatch[] = []
  for (const sentence of sentences) {
    try {
      const res = await axios.get("https://www.googleapis.com/customsearch/v1", {
        params: { key, cx, q: `"${sentence.slice(0, 300)}"` },
        timeout: 8000,
      })
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
  return { enabled: true, matches }
}

export interface PlagiarismResult {
  submissionId: number
  studentUserId: number
  studentFullName: string
  maxSimilarityPct: number
  matchedSubmissionId: number | null
  matchedStudentName: string | null
  internetEnabled: boolean
  internetMatches: InternetMatch[]
  checkedAt: string
}

/** Berilgan topshiriq (content) bo'yicha barcha topshirilgan ishlarni
    talaba-talaba solishtiradi va (sozlangan bo'lsa) internetdan qidiradi,
    natijalarni lms_plagiarism_checks'ga keshlaydi. */
export async function runPlagiarismCheck(contentId: number, submissions: SubmissionRecord[]): Promise<PlagiarismResult[]> {
  const texts = new Map<number, string>()
  for (const sub of submissions) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT extracted_text FROM lms_submissions WHERE id = ?", [sub.id])
    const cached = rows[0]?.extracted_text
    if (typeof cached === "string") {
      texts.set(sub.id, cached)
    } else {
      const extracted = await extractSubmissionText(sub)
      await pool.query("UPDATE lms_submissions SET extracted_text = ? WHERE id = ?", [extracted, sub.id])
      texts.set(sub.id, extracted)
    }
  }

  const shinglesById = new Map<number, Set<string>>()
  for (const sub of submissions) {
    shinglesById.set(sub.id, buildShingles(normalizeText(texts.get(sub.id) ?? "")))
  }

  const results: PlagiarismResult[] = []
  for (const sub of submissions) {
    const mySet = shinglesById.get(sub.id)!
    let best = 0
    let bestId: number | null = null
    let bestName: string | null = null
    for (const other of submissions) {
      if (other.id === sub.id) continue
      const sim = jaccardSimilarity(mySet, shinglesById.get(other.id)!)
      if (sim > best) { best = sim; bestId = other.id; bestName = other.studentFullName }
    }

    const internet = await checkInternet(texts.get(sub.id) ?? "")
    const maxSimilarityPct = Math.round(best * 1000) / 10

    results.push({
      submissionId: sub.id,
      studentUserId: sub.studentUserId,
      studentFullName: sub.studentFullName,
      maxSimilarityPct,
      matchedSubmissionId: bestId,
      matchedStudentName: bestName,
      internetEnabled: internet.enabled,
      internetMatches: internet.matches,
      checkedAt: new Date().toISOString(),
    })

    await pool.query(
      `INSERT INTO lms_plagiarism_checks
         (content_id, submission_id, student_user_id, student_full_name, max_similarity_pct,
          matched_submission_id, matched_student_name, internet_enabled, internet_matches)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         student_full_name     = VALUES(student_full_name),
         max_similarity_pct    = VALUES(max_similarity_pct),
         matched_submission_id = VALUES(matched_submission_id),
         matched_student_name  = VALUES(matched_student_name),
         internet_enabled      = VALUES(internet_enabled),
         internet_matches      = VALUES(internet_matches),
         checked_at            = CURRENT_TIMESTAMP`,
      [
        contentId, sub.id, sub.studentUserId, sub.studentFullName, maxSimilarityPct,
        bestId, bestName, internet.enabled ? 1 : 0, JSON.stringify(internet.matches),
      ]
    )
  }

  return results
}

export async function getCachedPlagiarismResults(contentId: number): Promise<PlagiarismResult[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_plagiarism_checks WHERE content_id = ? ORDER BY max_similarity_pct DESC",
    [contentId]
  )
  return rows.map((r) => ({
    submissionId: Number(r.submission_id),
    studentUserId: Number(r.student_user_id),
    studentFullName: String(r.student_full_name),
    maxSimilarityPct: Number(r.max_similarity_pct),
    matchedSubmissionId: r.matched_submission_id != null ? Number(r.matched_submission_id) : null,
    matchedStudentName: r.matched_student_name ?? null,
    internetEnabled: Boolean(r.internet_enabled),
    internetMatches: r.internet_matches
      ? (typeof r.internet_matches === "string" ? JSON.parse(r.internet_matches) : r.internet_matches)
      : [],
    checkedAt: String(r.checked_at),
  }))
}
