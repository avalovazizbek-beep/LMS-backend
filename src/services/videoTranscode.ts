import fs from "fs"
import path from "path"
import crypto from "crypto"
import { spawn } from "child_process"
import type { RowDataPacket } from "mysql2"
import { pool } from "./db"
import { privateStorageRoot, storedFilePath } from "./teachingStore"

/* ── O'qituvchi yuklagan videolarni har qanday telefon o'ynata oladigan
   MP4 ga keltirish ──────────────────────────────────────────────────────
   Muammo: ba'zi talabalarda video telefonda ochilmasdi (qora ekran, 0:00).
   Sabablar — yuklangan faylning o'zida:
     • kodek/konteyner: HEVC (H.265), .mov/.mkv/.avi, 10-bit — ko'p mobil
       brauzerlar o'ynatmaydi (kompyuterdagi pleer esa o'ynatadi);
     • o'lcham: masalan 2284×1324 ekran yozuvi — telefonlarning apparat
       dekoderi odatda 1920×1080 dan kattasini o'qiy olmaydi;
     • "moov" bloki fayl oxirida — telefon avval fayl oxirini yuklab olishi
       kerak, sekin internetda 0:00 da qotib qoladi.
   Yechim: fon rejimida (navbat bilan, bittadan, past ustuvorlikda) har bir
   videoni tekshiradi:
     ok      — allaqachon mos (H.264 ≤1080p yuv420p, AAC/MP3, faststart .mp4);
     remux   — kodek mos, faqat konteyner/faststart — `-c copy`, soniyalarda,
               sifat o'zgarmaydi;
     encode  — H.264/AAC ga qayta kodlash (≤1920×1080).
   Mavzu boshqa guruhlarga nusxalanganda fayl ham nusxalanadi — bir xil
   fayllar (fingerprint) bir marta kodlanadi, qolganiga natija nusxalanadi.
   Serverda ffmpeg bo'lmasa xizmat o'chiq qoladi (log'da ogohlantirish). */

/* ── Tashqi dastur faqat ffmpeg/ffprobe — buyruq hech qachon foydalanuvchidan
   yoki bazadan kelmaydi. .env'da FFMPEG_PATH/FFPROBE_PATH berilsa, faqat
   mutlaq yo'l va fayl nomi aynan shu dastur bo'lsa qabul qilinadi. ── */
export type Tool = "ffmpeg" | "ffprobe"

export function toolBinary(tool: Tool, configured: string | undefined): string {
  const value = (configured || "").trim()
  if (!value) return tool
  const name = path.basename(value).toLowerCase().replace(/\.exe$/, "")
  if (path.isAbsolute(value) && name === tool) return value
  console.warn("%s %s_PATH yaroqsiz — standart \"%s\" ishlatiladi", "[video]", tool.toUpperCase(), tool)
  return tool
}

const FFMPEG_BIN = toolBinary("ffmpeg", process.env.FFMPEG_PATH)
const FFPROBE_BIN = toolBinary("ffprobe", process.env.FFPROBE_PATH)

/* ── Kirish fayli faqat oddiy video konteyner sifatida o'qiladi ──
   Yuklangan ".mp4" aslida HLS/concat ro'yxati bo'lsa, ffmpeg undagi boshqa
   fayllarni (masalan /etc/passwd) yoki URL'larni o'qib, natijani videoga
   yozib qo'yishi mumkin. Shuning uchun: faqat "file" protokoli, faqat shu
   demuxerlar, yo'l oldiga "file:" (nom "-" yoki "http:" bilan boshlansa ham
   opsiya/protokol deb o'qilmaydi). */
export const ALLOWED_DEMUXERS = ["mov", "mp4", "m4a", "3gp", "3g2", "mj2", "matroska", "webm", "avi", "mpeg", "mpegts", "flv", "asf", "ogg"]
const INPUT_GUARD = ["-protocol_whitelist", "file", "-format_whitelist", ALLOWED_DEMUXERS.join(",")]

/** ffprobe qaytargan format_name (masalan "mov,mp4,m4a,3gp,3g2,mj2") ruxsat etilganmi */
export function isAllowedContainer(formatName: string | undefined): boolean {
  const parts = String(formatName || "").split(",").map(p => p.trim()).filter(Boolean)
  return parts.length > 0 && parts.some(p => ALLOWED_DEMUXERS.includes(p))
}

export function fileArg(file: string): string {
  return `file:${file}`
}
const MAX_LONG_SIDE = 1920
const MAX_SHORT_SIDE = 1080
const SCAN_INTERVAL_MS = Number(process.env.VIDEO_SCAN_INTERVAL_MS) || 2 * 60_000
const FIRST_SCAN_DELAY_MS = 60_000
const MAX_ATTEMPTS = 3
const ENCODE_TIMEOUT_MS = 4 * 60 * 60_000
const LOG = "[video]"

type RunResult = { code: number | null; stdout: string; stderr: string }

let niceOk = false

/** ffmpeg/ffprobe'ni shell'siz ishga tushiradi: argumentlar massiv bo'lib
    to'g'ridan-to'g'ri dasturga boradi, ";", "|", "$(...)" kabi belgilar
    buyruq sifatida talqin qilinmaydi. */
export function runProcess(tool: Tool, args: readonly string[], timeoutMs: number, lowPriority = false): Promise<RunResult> {
  if (tool !== "ffmpeg" && tool !== "ffprobe") return Promise.reject(new Error("ruxsat etilmagan dastur"))
  const bin = tool === "ffprobe" ? FFPROBE_BIN : FFMPEG_BIN
  const argv = args.map(String)
  return new Promise((resolve, reject) => {
    // Linux'da `nice` — meeting (mediasoup) va API'dan protsessor tortib olmasin
    const child = lowPriority && niceOk
      ? spawn("nice", ["-n", "15", bin, ...argv], { windowsHide: true, shell: false })
      : spawn(bin, argv, { windowsHide: true, shell: false })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { if (stdout.length < 2_000_000) stdout += d })
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-8000) })
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.on("error", (err) => { clearTimeout(timer); reject(err) })
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  pix_fmt?: string
  width?: number
  height?: number
}
interface Probe {
  streams: ProbeStream[]
  format: { format_name?: string; duration?: string }
}

export async function probe(file: string): Promise<Probe | null> {
  try {
    const r = await runProcess("ffprobe", ["-v", "error", ...INPUT_GUARD, "-print_format", "json", "-show_streams", "-show_format", fileArg(file)], 60_000)
    if (r.code !== 0) return null
    const parsed = JSON.parse(r.stdout) as Probe
    if (!isAllowedContainer(parsed.format?.format_name)) return null
    return { streams: parsed.streams ?? [], format: parsed.format ?? {} }
  } catch {
    return null
  }
}

/** MP4/MOV yuqori darajadagi bloklar: "moov" "mdat"dan oldinmi (faststart) */
function moovBeforeMdat(file: string): boolean {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, "r")
    const size = fs.fstatSync(fd).size
    const head = Buffer.alloc(16)
    let pos = 0
    for (let i = 0; i < 64 && pos + 8 <= size; i++) {
      fs.readSync(fd, head, 0, 16, pos)
      let boxSize = head.readUInt32BE(0)
      const type = head.toString("latin1", 4, 8)
      if (type === "moov") return true
      if (type === "mdat") return false
      if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8))
      else if (boxSize === 0) return false
      if (boxSize < 8) return false
      pos += boxSize
    }
    return false
  } catch {
    return false
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

/** Tez barmoq izi: hajm + boshidagi va oxiridagi 1 MB — bir xil nusxalarni tanish uchun.
    SHA-256, ustun CHAR(40) bo'lgani uchun birinchi 40 hex belgisi saqlanadi. */
function fingerprint(file: string): string {
  const fd = fs.openSync(file, "r")
  try {
    const size = fs.fstatSync(fd).size
    const hash = crypto.createHash("sha256").update(String(size))
    const chunk = Buffer.alloc(Math.min(1_048_576, size))
    fs.readSync(fd, chunk, 0, chunk.length, 0)
    hash.update(chunk)
    fs.readSync(fd, chunk, 0, chunk.length, Math.max(0, size - chunk.length))
    hash.update(chunk)
    return hash.digest("hex").slice(0, 40)
  } finally {
    fs.closeSync(fd)
  }
}

export type Plan = { action: "ok" | "remux" | "encode"; audioCopy: boolean; reason: string }

function plan(p: Probe, ext: string, faststart: boolean): Plan | null {
  const v = p.streams.find(s => s.codec_type === "video")
  if (!v) return null
  const a = p.streams.find(s => s.codec_type === "audio")
  const long = Math.max(v.width ?? 0, v.height ?? 0)
  const short = Math.min(v.width ?? 0, v.height ?? 0)
  const videoOk = v.codec_name === "h264" &&
    (v.pix_fmt === "yuv420p" || v.pix_fmt === "yuvj420p") &&
    long <= MAX_LONG_SIDE && short <= MAX_SHORT_SIDE
  const audioOk = !a || a.codec_name === "aac" || a.codec_name === "mp3"
  const mp4Family = (p.format.format_name ?? "").includes("mp4")

  if (!videoOk) {
    return { action: "encode", audioCopy: false, reason: `${v.codec_name}/${v.pix_fmt} ${v.width}x${v.height}` }
  }
  if (audioOk && mp4Family && ext === ".mp4" && faststart) return { action: "ok", audioCopy: true, reason: "mos" }
  return { action: "remux", audioCopy: audioOk, reason: !audioOk ? `audio ${a?.codec_name}` : !faststart ? "faststart yo'q" : `konteyner ${ext}` }
}

// Uzun tomoni ≤1920, qisqasi ≤1080 (portret videoda ham), juft o'lcham.
// Bitta qo'shtirnoq — vergullar filtrlar ajratuvchisi deb o'qilmasin.
const SCALE = "scale='trunc(iw*min(1,min(1920/max(iw,ih),1080/min(iw,ih)))/2)*2':'trunc(ih*min(1,min(1920/max(iw,ih),1080/min(iw,ih)))/2)*2'"

export function ffmpegArgs(input: string, output: string, p: Plan): string[] {
  const head = ["-hide_banner", "-nostdin", "-y", ...INPUT_GUARD, "-i", fileArg(input), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]
  const audio = p.audioCopy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]
  const video = p.action === "remux"
    ? ["-c:v", "copy"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-pix_fmt", "yuv420p", "-vf", SCALE, "-threads", "2"]
  return [...head, ...video, ...audio, "-movflags", "+faststart", "-f", "mp4", fileArg(output)]
}

function durationOf(p: Probe | null): number {
  return Number(p?.format.duration) || 0
}

async function mark(relativePath: string, status: "ok" | "converted" | "failed", extra: { action?: string; output?: string | null; fp?: string | null; error?: string | null; bumpAttempt?: boolean }) {
  await pool.query(
    `INSERT INTO lms_video_transcode (relative_path, status, action, output_path, fingerprint, attempts, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), action = VALUES(action), output_path = VALUES(output_path),
       fingerprint = COALESCE(VALUES(fingerprint), fingerprint), attempts = attempts + ?, error = VALUES(error)`,
    [relativePath, status, extra.action ?? null, extra.output ?? null, extra.fp ?? null, extra.bumpAttempt ? 1 : 0, extra.error ?? null, extra.bumpAttempt ? 1 : 0]
  )
}

/** Kontent qatorlarini yangi faylga o'tkazadi (bir yo'lga bir nechta qator ishora qilishi mumkin) */
async function swapFile(oldRel: string, newRel: string, newName: string, size: number) {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT id, original_name FROM lms_teacher_content WHERE relative_path = ?", [oldRel])
  for (const r of rows) {
    const original = String(r.original_name || "video").replace(/\.[^.]+$/, "") + ".mp4"
    await pool.query(
      "UPDATE lms_teacher_content SET file_name = ?, original_name = ?, mime_type = 'video/mp4', file_size = ?, relative_path = ? WHERE id = ?",
      [newName, original, size, newRel, r.id]
    )
  }
}

let currentJob: { relativePath: string; action: string; startedAt: number } | null = null

async function processOne(relativePath: string): Promise<void> {
  const root = privateStorageRoot()
  const input = storedFilePath(root, relativePath)
  if (!input || !fs.existsSync(input)) { // nosemgrep
    await mark(relativePath, "failed", { error: "fayl topilmadi", bumpAttempt: true })
    return
  }
  const ext = path.extname(input).toLowerCase()
  const fp = fingerprint(input)

  // Bir xil nusxa avval konvertatsiya qilingan bo'lsa — natijani nusxalaymiz
  const [done] = await pool.query<RowDataPacket[]>(
    "SELECT output_path FROM lms_video_transcode WHERE fingerprint = ? AND status = 'converted' AND output_path IS NOT NULL LIMIT 5", [fp]
  )
  for (const d of done) {
    const prev = storedFilePath(root, String(d.output_path))
    if (!prev || !fs.existsSync(prev)) continue // nosemgrep
    const name = `${path.basename(input, ext).slice(0, 80)}-web.mp4`
    const outRel = `${path.posix.dirname(relativePath)}/${name}`
    const out = storedFilePath(root, outRel)
    if (!out) break
    await fs.promises.copyFile(prev, out) // nosemgrep
    await swapFile(relativePath, outRel, name, fs.statSync(out).size) // nosemgrep
    await mark(relativePath, "converted", { action: "copy", output: outRel, fp })
    await mark(outRel, "ok", { action: "ok", fp: null })
    fs.rm(input, { force: true }, () => undefined) // nosemgrep
    console.log("%s %s → %s (avvalgi natijadan nusxa)", LOG, relativePath, outRel)
    return
  }

  const info = await probe(input)
  if (!info) {
    await mark(relativePath, "failed", { error: "ffprobe o'qiy olmadi", fp, bumpAttempt: true })
    return
  }
  const p = plan(info, ext, moovBeforeMdat(input))
  if (!p) {
    await mark(relativePath, "failed", { error: "video oqimi yo'q", fp, bumpAttempt: true })
    return
  }
  if (p.action === "ok") {
    await mark(relativePath, "ok", { action: "ok", fp })
    return
  }

  const name = `${path.basename(input, ext).slice(0, 80)}-web.mp4`
  const outRel = `${path.posix.dirname(relativePath)}/${name}`
  const out = storedFilePath(root, outRel)
  if (!out) {
    await mark(relativePath, "failed", { error: "chiqish yo'li noto'g'ri", fp, bumpAttempt: true })
    return
  }
  const tmp = `${out}.part`
  currentJob = { relativePath, action: p.action, startedAt: Date.now() }
  console.log("%s %s: %s (%s)", LOG, relativePath, p.action, p.reason)
  try {
    const r = await runProcess("ffmpeg", ffmpegArgs(input, tmp, p), ENCODE_TIMEOUT_MS, p.action === "encode")
    if (r.code !== 0) throw new Error(r.stderr.split("\n").filter(Boolean).slice(-3).join(" | ") || `ffmpeg kodi ${r.code}`)
    // Natija butunligini tekshiramiz: davomiyligi aslidan sezilarli farq qilmasin
    const before = durationOf(info)
    const after = durationOf(await probe(tmp))
    if (!after || (before && Math.abs(before - after) > Math.max(2, before * 0.02))) {
      throw new Error(`davomiylik mos emas: ${before} → ${after}`)
    }
    fs.renameSync(tmp, out) // nosemgrep
    await swapFile(relativePath, outRel, name, fs.statSync(out).size) // nosemgrep
    await mark(relativePath, "converted", { action: p.action, output: outRel, fp })
    await mark(outRel, "ok", { action: "ok" })
    fs.rm(input, { force: true }, () => undefined) // nosemgrep
    console.log("%s tayyor: %s (%ds)", LOG, outRel, Math.round((Date.now() - currentJob.startedAt) / 1000))
  } catch (err) {
    fs.rm(tmp, { force: true }, () => undefined) // nosemgrep
    const message = err instanceof Error ? err.message : String(err)
    console.warn("%s xato %s: %s", LOG, relativePath, message)
    await mark(relativePath, "failed", { action: p.action, error: message.slice(0, 2000), fp, bumpAttempt: true })
  } finally {
    currentJob = null
  }
}

/** `nice` bor va ishlaydimi (Linux) — past ustuvorlikda kodlash uchun */
function niceWorks(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("nice", ["-n", "15", FFMPEG_BIN, "-version"], { windowsHide: true, shell: false, stdio: "ignore" })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}

let available: boolean | null = null
let scanning = false

async function ffmpegAvailable(): Promise<boolean> {
  if (available !== null) return available
  try {
    const [a, b] = await Promise.all([runProcess("ffmpeg", ["-version"], 15_000), runProcess("ffprobe", ["-version"], 15_000)])
    available = a.code === 0 && b.code === 0
  } catch {
    available = false
  }
  if (available && process.platform !== "win32") {
    niceOk = await niceWorks()
  }
  if (!available) console.warn("%s ffmpeg/ffprobe topilmadi — videolar telefonlarga moslashtirilmaydi (o'rnatish: sudo apt install -y ffmpeg)", LOG)
  return available
}

/** Hali tekshirilmagan (yoki xato bilan qolgan) videolarni navbat bilan ishlaydi */
export async function scanVideos(): Promise<void> {
  if (scanning) return
  if (!(await ffmpegAvailable())) return
  scanning = true
  try {
    for (;;) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT DISTINCT c.relative_path
           FROM lms_teacher_content c
           LEFT JOIN lms_video_transcode v ON v.relative_path = c.relative_path
          WHERE c.relative_path IS NOT NULL AND c.relative_path <> ''
            AND (c.mime_type LIKE 'video/%' OR c.kind = 'video_lesson')
            AND (v.relative_path IS NULL
                 OR (v.status = 'failed' AND v.attempts < ? AND v.updated_at < NOW() - INTERVAL 30 MINUTE))
          LIMIT 10`,
        [MAX_ATTEMPTS]
      )
      if (!rows.length) break
      for (const r of rows) {
        const rel = String(r.relative_path)
        try {
          await processOne(rel)
        } catch (err) {
          // Kutilmagan xato (masalan fayl o'qilmadi) — navbat to'xtab qolmasin
          const message = err instanceof Error ? err.message : String(err)
          console.warn("%s xato %s: %s", LOG, rel, message)
          await mark(rel, "failed", { error: message.slice(0, 2000), bumpAttempt: true }).catch(() => {})
        }
      }
    }
  } catch (err) {
    console.warn("%s skan xatosi: %s", LOG, err instanceof Error ? err.message : String(err))
  } finally {
    scanning = false
  }
}

export function startVideoTranscoder() {
  setTimeout(() => { void scanVideos() }, FIRST_SCAN_DELAY_MS)
  setInterval(() => { void scanVideos() }, SCAN_INTERVAL_MS)
}

/** Admin uchun holat: nechta video tekshirilgan/o'zgartirilgan/xato, hozir nima ishlanmoqda */
export async function getVideoTranscodeStatus() {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT status, action, COUNT(*) AS n FROM lms_video_transcode GROUP BY status, action"
  )
  const [failed] = await pool.query<RowDataPacket[]>(
    "SELECT relative_path, attempts, error, updated_at FROM lms_video_transcode WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20"
  )
  return {
    ffmpeg: available,
    running: currentJob ? { ...currentJob, seconds: Math.round((Date.now() - currentJob.startedAt) / 1000) } : null,
    counts: rows.map(r => ({ status: String(r.status), action: r.action ? String(r.action) : null, n: Number(r.n) })),
    failed: failed.map(f => ({ path: String(f.relative_path), attempts: Number(f.attempts), error: f.error ? String(f.error) : null, at: f.updated_at })),
  }
}
