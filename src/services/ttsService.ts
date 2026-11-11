import crypto from "crypto"
import fs from "fs"
import path from "path"
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts"

/* ── Ovozli yordamchi uchun matn → nutq (MP3) ───────────────────────────
 * Maxsus ehtiyojli (ko'zi ojiz) talabaga sayt tabiiy ovozda gapiradi.
 * Ovoz — Microsoft Edge "ovoz chiqarib o'qish" xizmatining neyron ovozlari
 * (LMS video darsliklari va SIES AI Voice agentidagi bilan bir xil:
 * uz-UZ-MadinaNeural). Kalit kerak emas, lekin server internetga
 * (speech.platform.bing.com, 443) chiqa olishi shart. Bu rasmiy API emas —
 * Microsoft o'zgartirsa ishlamay qolishi mumkin; u holda frontend
 * brauzerning o'z ovoziga qaytadi (lib/voiceAssist.ts).
 *
 * Bir xil matn qayta sintez qilinmaydi: MP3 diskda saqlanadi
 * (storage/tts-cache/<sha256>.mp3) — menyu va tugma nomlari bir marta olinadi. */

export const TTS_MAX_CHARS = 500

const VOICES: Record<string, string> = {
  uz: process.env.TTS_VOICE_UZ || "uz-UZ-MadinaNeural",
  ru: "ru-RU-SvetlanaNeural",
  en: "en-US-AriaNeural",
}

/** Sayt tili → ovoz. Kirill o'zbekcha va qoraqalpoqcha ham o'zbek ovozida o'qiladi. */
export function ttsVoiceFor(lang: unknown): string {
  return lang === "ru" ? VOICES.ru : lang === "en" ? VOICES.en : VOICES.uz
}

const STORAGE_ROOT = path.resolve(process.env.LOCAL_RESOURCE_STORAGE || path.join(process.cwd(), "storage"))
const CACHE_DIR = path.join(STORAGE_ROOT, "tts-cache")
const SYNTH_TIMEOUT_MS = 15_000
const MAX_PARALLEL = 4

const inFlight = new Map<string, Promise<Buffer>>()
let running = 0
const waiters: Array<() => void> = []

async function acquire(): Promise<void> {
  if (running < MAX_PARALLEL) { running += 1; return }
  await new Promise<void>((resolve) => waiters.push(resolve))
  running += 1
}
function release() {
  running -= 1
  waiters.shift()?.()
}

/** Ovoz o'qimaydigan belgilarni olib tashlash, bo'shliqlarni yig'ish */
export function normalizeTtsText(raw: unknown): string {
  if (typeof raw !== "string") return ""
  return raw
    .replace(/[\u0000-\u001f<>]/g, " ")
    // O'zbek lotin apostroflari bir xil ko'rinishga: o', g' — ovoz to'g'ri talaffuz qilsin
    .replace(/[`´‘’ʻʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TTS_MAX_CHARS)
}

async function synthesize(text: string, voice: string): Promise<Buffer> {
  await acquire()
  const tts = new MsEdgeTTS()
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("TTS vaqti tugadi")), SYNTH_TIMEOUT_MS)
      const done = (fn: () => void) => { clearTimeout(timer); fn() }
      tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        .then(() => {
          const { audioStream } = tts.toStream(text)
          const parts: Buffer[] = []
          audioStream.on("data", (chunk: Buffer) => parts.push(chunk))
          audioStream.on("error", (err: Error) => done(() => reject(err)))
          audioStream.on("end", () => done(() => {
            const audio = Buffer.concat(parts)
            if (audio.length < 200) reject(new Error("TTS bo'sh javob qaytardi"))
            else resolve(audio)
          }))
        })
        .catch((err) => done(() => reject(err)))
    })
  } finally {
    try { tts.close() } catch { /* ulanish allaqachon yopilgan */ }
    release()
  }
}

/** Matn uchun MP3 (keshdan yoki yangi sintez) */
export async function ttsAudio(text: string, voice: string): Promise<Buffer> {
  const key = crypto.createHash("sha256").update(`${voice}\n${text}`, "utf8").digest("hex")
  const file = path.join(CACHE_DIR, `${key}.mp3`) // nosemgrep — nom faqat sha256 hex
  try {
    return await fs.promises.readFile(file)
  } catch { /* keshda yo'q */ }

  let job = inFlight.get(key)
  if (!job) {
    job = synthesize(text, voice)
      .then(async (audio) => {
        try {
          await fs.promises.mkdir(CACHE_DIR, { recursive: true })
          await fs.promises.writeFile(file, audio)
        } catch { /* kesh yozilmasa ham ovoz qaytadi */ }
        return audio
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, job)
  }
  return job
}
