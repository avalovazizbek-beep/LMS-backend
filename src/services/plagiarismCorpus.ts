import type mysql from "mysql2/promise"
import { pool } from "./db"

/* ── Antiplagiat: saytdagi BARCHA topshirilgan ishlar bo'yicha qidiruv indeksi ──
 * Har bir ish matni 4 so'zli bo'laklarga bo'linadi, har bo'lak 32-bitli xeshga
 * aylanadi va har uchinchisi saqlanadi (xotirani tejash). Teskari indeks
 * (xesh → ishlar) orqali berilgan ishga eng ko'p bo'lagi mos keladigan
 * nomzodlar bir zumda topiladi; aniq foiz esa plagiarismStore'da nomzodlarning
 * to'liq matni bilan hisoblanadi.
 *
 * Indeks xotirada turadi (server qayta ishga tushsa birinchi tekshiruvda qayta
 * quriladi) va har tekshiruvdan oldin yangilanadi: faqat matni yangi yoki
 * o'zgargan ishlar qayta o'qiladi. */

const CORPUS_SHINGLE = 4
const SAMPLE_MOD = 3
const MIN_WORDS = 30

interface CorpusDoc {
  studentUserId: number
  contentId: number
  sig: string
  hashes: Uint32Array
}

const docs = new Map<number, CorpusDoc>()
let inverted = new Map<number, number[]>()
let refreshing: Promise<void> | null = null
let lastRefresh = 0

export function corpusWords(text: string): string[] {
  return text.toLowerCase().replace(/[`´‘’ʻʼ']/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean)
}

function fnv(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}

/** Matnning saralangan bo'lak xeshlari (takrorsiz) */
export function sampledHashes(text: string): Uint32Array {
  const words = corpusWords(text)
  if (words.length < MIN_WORDS) return new Uint32Array(0)
  const set = new Set<number>()
  for (let i = 0; i + CORPUS_SHINGLE <= words.length; i++) {
    const h = fnv(words.slice(i, i + CORPUS_SHINGLE).join(" "))
    if (h % SAMPLE_MOD === 0) set.add(h)
  }
  return Uint32Array.from(set)
}

async function refresh(): Promise<void> {
  // Avval yengil so'rov: qaysi ishlar bor va matni o'zgarganmi
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, student_user_id, content_id, IFNULL(text_sig, '') AS sig, CHAR_LENGTH(extracted_text) AS len
     FROM lms_submissions WHERE extracted_text IS NOT NULL AND CHAR_LENGTH(extracted_text) >= 150`
  )
  const alive = new Set<number>()
  const stale: number[] = []
  for (const r of rows) {
    const id = Number(r.id)
    alive.add(id)
    const sig = `${r.sig}|${r.len}`
    if (docs.get(id)?.sig !== sig) stale.push(id)
  }
  let changed = false
  for (const id of [...docs.keys()]) if (!alive.has(id)) { docs.delete(id); changed = true }

  for (let i = 0; i < stale.length; i += 200) {
    const [texts] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id, student_user_id, content_id, IFNULL(text_sig, '') AS sig, CHAR_LENGTH(extracted_text) AS len, extracted_text
       FROM lms_submissions WHERE id IN (?)`, [stale.slice(i, i + 200)]
    )
    for (const r of texts) {
      docs.set(Number(r.id), {
        studentUserId: Number(r.student_user_id), contentId: Number(r.content_id),
        sig: `${r.sig}|${r.len}`, hashes: sampledHashes(String(r.extracted_text)),
      })
      changed = true
    }
  }

  if (changed || inverted.size === 0) {
    const next = new Map<number, number[]>()
    for (const [id, doc] of docs) {
      for (const h of doc.hashes) {
        const list = next.get(h)
        if (list) list.push(id)
        else next.set(h, [id])
      }
    }
    inverted = next
  }
  lastRefresh = Date.now()
}

/** Indeksni yangilaydi (bir vaqtda bitta yangilanish; 20 soniyada bir martadan ko'p emas) */
export async function ensureCorpus(): Promise<{ documents: number }> {
  if (!refreshing && Date.now() - lastRefresh > 20_000) {
    refreshing = refresh().finally(() => { refreshing = null })
  }
  if (refreshing) await refreshing
  return { documents: docs.size }
}

/**
 * Berilgan matnga eng ko'p bo'lagi mos keladigan ishlar (saytdagi barcha ishlar ichidan).
 * @param excludeStudentId shu talabaning o'z ishlari hisobga olinmaydi (o'zidan ko'chirish — plagiat emas)
 * @param excludeContentId shu topshiriqdagi ishlar hisobga olinmaydi (ular alohida, to'liq solishtiriladi)
 */
export function findCandidates(text: string, excludeStudentId: number, excludeContentId: number, limit = 4): number[] {
  const hashes = sampledHashes(text)
  if (!hashes.length) return []
  const counts = new Map<number, number>()
  for (const h of hashes) {
    const list = inverted.get(h)
    if (!list) continue
    for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const scored: Array<[number, number]> = []
  for (const [id, n] of counts) {
    const doc = docs.get(id)
    if (!doc || doc.studentUserId === excludeStudentId || doc.contentId === excludeContentId) continue
    // Kamida 3 ta bo'lak va matnning 4% i mos kelsa — nomzod (tasodifiy umumiy iboralar emas)
    if (n >= 3 && n / hashes.length >= 0.04) scored.push([id, n])
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id)
}
