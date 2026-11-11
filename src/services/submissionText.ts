import path from "path"
import os from "os"
import fs from "fs"
import crypto from "crypto"
import { execFile } from "child_process"
import type mysql from "mysql2/promise"
import { convertWithLibreOffice } from "./officeConvert"
import { pool } from "./db"
import { privateStorageRoot, storedFilePath } from "./teachingStore"

/* ── Talaba ishidan matn ajratib olish (antiplagiat va AI tavsiya uchun) ──
 * Matn fayldan to'g'ridan-to'g'ri olinadi; fayl rasm, skanerlangan PDF yoki
 * ichi rasmdan iborat Word bo'lsa — OCR (rasmni matnga aylantirish):
 *   - rasm (.jpg/.png/...)        → tesseract
 *   - PDF: pdftotext; matn kam    → pdftoppm (sahifalar rasmga) → tesseract
 *   - Word/PowerPoint: LibreOffice; matn kam → PDF → pdftoppm → tesseract
 * Serverda kerak:  apt-get install -y tesseract-ocr tesseract-ocr-uzb
 *                  tesseract-ocr-uzb-cyrl tesseract-ocr-rus poppler-utils
 * O'rnatilmagan bo'lsa OCR o'tkazib yuboriladi (eski xatti-harakat), xato chiqmaydi.
 *
 * Natija lms_submissions'da keshlanadi: extracted_text, text_source, text_sig
 * (fayl yo'li + hajmi — talaba faylni almashtirsa qayta o'qiladi).
 * Fondagi ishchi (startSubmissionTextWorker) yangi ishlarni o'zi tayyorlab
 * turadi — o'qituvchi "Antiplagiat"ni bosganda matnlar tayyor bo'ladi. */

export type TextSource = "text" | "ocr" | "none"

export interface ExtractedText {
  text: string
  source: TextSource
}

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".gif"])
const OFFICE_EXT = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".odt", ".odp"])
// Shundan kam so'z chiqsa — fayl aslida rasm/skaner deb hisoblanadi va OCR qilinadi
const MIN_WORDS_BEFORE_OCR = 40
const MAX_OCR_PAGES = 12
const OCR_DPI = 170

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
        // Dastur o'rnatilmagan (ENOENT) — boshqa xatolardan farqlanadi
        missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT",
      })
    })
  })
}

const wordCount = (text: string) => (text.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length

/* ── Vositalar bor-yo'qligi (bir marta aniqlanadi) ──────────────────── */

let toolsPromise: Promise<{ tesseract: boolean; langs: string; pdftotext: boolean; pdftoppm: boolean }> | null = null

export function ocrTools() {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      const list = await run("tesseract", ["--list-langs"], 10_000)
      // Eski versiyalar ro'yxatni stderr'ga yozadi
      const have = new Set(`${list.stdout}\n${list.stderr}`.split(/\r?\n/).map((s) => s.trim()))
      // O'zbek lotin + kirill + rus + ingliz — o'rnatilganlari
      const langs = ["uzb", "uzb_cyrl", "rus", "eng"].filter((l) => have.has(l)).join("+")
      const [pt, pp] = await Promise.all([run("pdftotext", ["-v"], 10_000), run("pdftoppm", ["-v"], 10_000)])
      return { tesseract: !list.missing && langs.length > 0, langs, pdftotext: !pt.missing, pdftoppm: !pp.missing }
    })()
  }
  return toolsPromise
}

// OCR protsessorni ko'p ishlatadi — bir vaqtda ko'pi bilan 2 ta fayl
let ocrRunning = 0
const ocrWaiters: Array<() => void> = []
async function withOcrSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (ocrRunning >= 2) await new Promise<void>((resolve) => ocrWaiters.push(resolve))
  ocrRunning += 1
  try {
    return await fn()
  } finally {
    ocrRunning -= 1
    ocrWaiters.shift()?.()
  }
}

async function ocrImage(imagePath: string, langs: string): Promise<string> {
  const res = await run("tesseract", [imagePath, "stdout", "-l", langs, "--psm", "3"], 90_000)
  return res.ok ? res.stdout : ""
}

/** PDF sahifalarini rasmga aylantirib, har birini OCR qiladi */
async function ocrPdf(pdfPath: string, langs: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-ocr-"))
  try {
    const res = await run("pdftoppm", ["-r", String(OCR_DPI), "-gray", "-png", "-f", "1", "-l", String(MAX_OCR_PAGES), pdfPath, path.join(dir, "p")], 120_000)
    if (!res.ok) return ""
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort()
    const parts: string[] = []
    for (const page of pages) parts.push(await ocrImage(path.join(dir, page), langs))
    return parts.join("\n\n")
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => undefined)
  }
}

async function libreOfficeTo(absPath: string, format: string, ext: string): Promise<string | null> {
  const dir = path.join(os.tmpdir(), "lms-plagiarism-txt")
  fs.mkdirSync(dir, { recursive: true })
  const out = path.join(dir, `${crypto.randomUUID()}.${ext}`)
  return (await convertWithLibreOffice(absPath, format, out)) ? out : null
}

function readAndRemove(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8") // nosemgrep — vaqtinchalik fayl, nomi serverda yaratilgan UUID
  } catch {
    return ""
  } finally {
    fs.rm(file, { force: true }, () => undefined) // nosemgrep
  }
}

function stripRtf(raw: string): string {
  return raw.replace(/\\[a-z]+-?\d*/gi, " ").replace(/[{}]/g, " ").replace(/\s+/g, " ").trim()
}

/** Bitta fayldan matn (kerak bo'lsa OCR bilan). absPath — server yaratgan, tekshirilgan yo'l. */
export async function extractFileText(absPath: string, originalName: string): Promise<ExtractedText> {
  const ext = path.extname(originalName).toLowerCase()
  const tools = await ocrTools()
  const canOcr = tools.tesseract

  if (ext === ".txt") {
    try { return { text: fs.readFileSync(absPath, "utf-8"), source: "text" } } catch { return { text: "", source: "none" } } // nosemgrep
  }
  if (ext === ".rtf") {
    try { return { text: stripRtf(fs.readFileSync(absPath, "utf-8")), source: "text" } } catch { return { text: "", source: "none" } } // nosemgrep
  }

  if (IMAGE_EXT.has(ext)) {
    if (!canOcr) return { text: "", source: "none" }
    const text = await withOcrSlot(() => ocrImage(absPath, tools.langs))
    return wordCount(text) > 0 ? { text, source: "ocr" } : { text: "", source: "none" }
  }

  if (ext === ".pdf") {
    let text = ""
    if (tools.pdftotext) text = (await run("pdftotext", ["-enc", "UTF-8", "-layout", absPath, "-"], 60_000)).stdout
    if (!text) {
      const txt = await libreOfficeTo(absPath, "txt:Text", "txt")
      if (txt) text = readAndRemove(txt)
    }
    if (wordCount(text) >= MIN_WORDS_BEFORE_OCR || !canOcr || !tools.pdftoppm) {
      return wordCount(text) > 0 ? { text, source: "text" } : { text: "", source: "none" }
    }
    // Skanerlangan PDF (yoki rasmga olingan qo'lyozma)
    const ocr = await withOcrSlot(() => ocrPdf(absPath, tools.langs))
    return wordCount(ocr) > wordCount(text) ? { text: ocr, source: "ocr" } : { text, source: wordCount(text) > 0 ? "text" : "none" }
  }

  if (OFFICE_EXT.has(ext)) {
    const txt = await libreOfficeTo(absPath, "txt:Text", "txt")
    const text = txt ? readAndRemove(txt) : ""
    if (wordCount(text) >= MIN_WORDS_BEFORE_OCR || !canOcr || !tools.pdftoppm) {
      return wordCount(text) > 0 ? { text, source: "text" } : { text: "", source: "none" }
    }
    // Ichiga rasm qo'yilgan Word/PowerPoint: PDF → sahifalar → OCR
    const pdf = await libreOfficeTo(absPath, "pdf", "pdf")
    if (!pdf) return wordCount(text) > 0 ? { text, source: "text" } : { text: "", source: "none" }
    try {
      const ocr = await withOcrSlot(() => ocrPdf(pdf, tools.langs))
      return wordCount(ocr) > wordCount(text) ? { text: ocr, source: "ocr" } : { text, source: wordCount(text) > 0 ? "text" : "none" }
    } finally {
      fs.rm(pdf, { force: true }, () => undefined) // nosemgrep
    }
  }

  return { text: "", source: "none" }
}

/* ── Kesh: lms_submissions.extracted_text / text_source / text_sig ──── */

interface SubmissionFileRow {
  id: number
  comment: string | null
  original_name: string | null
  relative_path: string | null
  file_size: number | null
  extracted_text: string | null
  text_source: string | null
  text_sig: string | null
}

// "v2": OCR qo'shilgan versiya — eski keshdagi (OCR'siz, bo'sh) matnlar bir marta qayta o'qiladi
const sigOf = (row: SubmissionFileRow) => `v2|${row.relative_path ?? ""}|${row.file_size ?? 0}|${(row.comment ?? "").length}`

async function extractRow(row: SubmissionFileRow): Promise<ExtractedText> {
  const parts: string[] = []
  let source: TextSource = "none"
  if (row.comment?.trim()) { parts.push(row.comment.trim()); source = "text" }
  if (row.relative_path && row.original_name) {
    // Yo'l foydalanuvchidan emas — yuklashda server yaratib bazaga yozgan; storedFilePath() root ichida ekanini tekshiradi
    const absPath = storedFilePath(privateStorageRoot(), row.relative_path)
    if (absPath && fs.existsSync(absPath)) { // nosemgrep
      const file = await extractFileText(absPath, row.original_name)
      if (file.text.trim()) { parts.push(file.text.trim()); source = file.source }
    }
  }
  return { text: parts.join("\n\n").trim().slice(0, 400_000), source }
}

/** Ishning matni: keshdan, bo'lmasa (yoki fayl almashgan bo'lsa) ajratib olinadi va keshlanadi */
export async function getSubmissionText(submissionId: number): Promise<ExtractedText> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT id, comment, original_name, relative_path, file_size, extracted_text, text_source, text_sig FROM lms_submissions WHERE id = ?",
    [submissionId]
  )
  const row = rows[0] as SubmissionFileRow | undefined
  if (!row) return { text: "", source: "none" }
  const sig = sigOf(row)
  if (row.text_sig === sig && typeof row.extracted_text === "string") {
    return { text: row.extracted_text, source: (row.text_source as TextSource) ?? "text" }
  }
  const extracted = await extractRow(row)
  await pool.query("UPDATE lms_submissions SET extracted_text = ?, text_source = ?, text_sig = ? WHERE id = ?", [
    extracted.text, extracted.source, sig, row.id,
  ])
  return extracted
}

/* ── Fondagi ishchi: yangi / o'zgargan ishlarning matnini oldindan tayyorlaydi ── */

let scanning = false

async function scanOnce(): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    // Fayli bor va matni hali (shu fayl uchun) tayyorlanmagan ishlar — eng yangilari birinchi
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id FROM lms_submissions
       WHERE relative_path IS NOT NULL
         AND (text_sig IS NULL OR text_sig <> CONCAT('v2|', relative_path, '|', IFNULL(file_size, 0), '|', CHAR_LENGTH(IFNULL(comment, ''))))
       ORDER BY id DESC LIMIT 8`
    )
    for (const r of rows) {
      try {
        await getSubmissionText(Number(r.id))
      } catch (err) {
        console.warn("[matn] ish #%d o'qilmadi:", Number(r.id), err instanceof Error ? err.message : err)
        // Qayta-qayta urinmaslik uchun bo'sh natija bilan belgilanadi
        await pool.query(
          `UPDATE lms_submissions SET extracted_text = '', text_source = 'none',
             text_sig = CONCAT('v2|', IFNULL(relative_path, ''), '|', IFNULL(file_size, 0), '|', CHAR_LENGTH(IFNULL(comment, '')))
           WHERE id = ?`, [Number(r.id)]
        ).catch(() => undefined)
      }
    }
  } catch (err) {
    console.warn("[matn] navbatni o'qishda xato:", err instanceof Error ? err.message : err)
  } finally {
    scanning = false
  }
}

export function startSubmissionTextWorker(): void {
  void ocrTools().then((t) => {
    console.log(t.tesseract
      ? `✓ OCR tayyor (tesseract: ${t.langs}${t.pdftoppm ? "" : "; pdftoppm yo'q — skaner PDF o'qilmaydi"})`
      : "OCR o'rnatilmagan (tesseract yo'q) — rasm va skaner ishlar antiplagiatda o'qilmaydi")
  })
  setTimeout(() => { void scanOnce() }, 20_000)
  setInterval(() => { void scanOnce() }, 30_000)
}
