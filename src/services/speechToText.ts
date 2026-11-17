import { execFile } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"
import crypto from "crypto"

/* ── Ovozni matnga aylantirish (zaxira yo'l) ─────────────────────────────
   Brauzerning o'z nutq tanishi (Web Speech) iPhone'da ishlamaydi — u yerda
   sayt mikrofondan ovozni o'zi yozib oladi va shu yerga yuboradi.
   Tanish — serverdagi faster-whisper (scripts/whisper_transcribe.py), bepul,
   ma'lumot serverdan chiqmaydi.

   .env:
     WHISPER_PYTHON — python yo'li (standart: python3; venv bo'lsa to'liq yo'l)
     WHISPER_MODEL  — tiny | base | small | medium (standart: small)
     FFMPEG_PATH    — ixtiyoriy (standart: ffmpeg) ─────────────────────── */

const PYTHON = process.env.WHISPER_PYTHON || "python3"
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg"
const SCRIPT = path.resolve(__dirname, "../../scripts/whisper_transcribe.py")
const MAX_SECONDS = 60
const MAX_QUEUE = 4

const LANGS = new Set(["uz", "ru", "en"])
export function sttLang(lang: string): string {
  const l = lang === "uzc" || lang === "kaa" ? "uz" : lang
  return LANGS.has(l) ? l : "uz"
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)}: ${(stderr || err.message).toString().slice(-300)}`))
      else resolve(stdout.toString())
    })
  })
}

// Bir vaqtda bitta tanish (protsessor band bo'lmasin); navbat to'lsa — rad etiladi
let active = 0
const waiters: Array<() => void> = []
async function slot(): Promise<() => void> {
  if (active >= 1) {
    if (waiters.length >= MAX_QUEUE) throw new Error("BUSY")
    await new Promise<void>((resolve) => waiters.push(resolve))
  } else {
    active += 1
  }
  return () => {
    const next = waiters.shift()
    if (next) next()
    else active -= 1
  }
}

export async function transcribeAudio(audio: Buffer, lang: string): Promise<string> {
  const release = await slot()
  const id = crypto.randomBytes(8).toString("hex")
  const input = path.join(os.tmpdir(), `stt-${id}.bin`)
  const wav = path.join(os.tmpdir(), `stt-${id}.wav`)
  try {
    await fs.promises.writeFile(input, audio)
    // Har qanday formatdan (webm/ogg/mp4/wav) 16 kHz mono wav
    await run(FFMPEG, ["-y", "-v", "error", "-i", input, "-t", String(MAX_SECONDS), "-ar", "16000", "-ac", "1", wav], 30_000)
    const out = await run(PYTHON, [SCRIPT, wav, sttLang(lang)], 120_000)
    const last = out.trim().split("\n").pop() ?? ""
    const parsed = JSON.parse(last) as { text?: string }
    return String(parsed.text ?? "").trim()
  } finally {
    release()
    fs.promises.unlink(input).catch(() => {})
    fs.promises.unlink(wav).catch(() => {})
  }
}
