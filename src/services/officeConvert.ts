import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { pathToFileURL } from "url"

/* ── LibreOffice (soffice) orqali hujjat konvertatsiyasi ──────────────────
   2026-10-27: serverda ~/LMS/backend ichida yuzlab `core.*` to'plangan —
   hammasi `soffice.bin --headless --convert-to pdf` qulashi. Sabablari:
     • ishlamagan konvertatsiya "libreoffice" dan keyin darhol "soffice"
       bilan qayta urinilardi — ikkalasi bitta soffice.bin, har xato = 2 core;
     • hamma chaqiruv bitta umumiy profilni (~/.config/libreoffice)
       ishlatardi — TheoryViewer'ning HEAD + GET so'rovi yoki bir necha
       talaba bir vaqtda ochganda ikki soffice bitta profilda yiqiladi;
     • muddat tugaganda faqat wrapper (sh) o'ldirilib, soffice.bin yetim
       qolardi.
   Endi: har slot o'z profiliga ega, bir vaqtda ko'pi bilan MAX_PARALLEL ta,
   har ish o'z chiqish papkasida, muddat tugasa butun jarayon guruhi
   o'ldiriladi, keyingi dastur nomi faqat oldingisi topilmasa (ENOENT)
   sinanadi. */

const CANDIDATES = process.platform === "win32"
  ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "soffice"]
  : ["libreoffice", "soffice"]
const MAX_PARALLEL = 2
const LOG = "[office]"

let workingBin: string | null = null

const slotBusy: boolean[] = new Array(MAX_PARALLEL).fill(false)
const waiting: Array<(slot: number) => void> = []

function acquireSlot(): Promise<number> {
  const free = slotBusy.indexOf(false)
  if (free !== -1) {
    slotBusy[free] = true
    return Promise.resolve(free)
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function releaseSlot(slot: number): void {
  const next = waiting.shift()
  if (next) next(slot)
  else slotBusy[slot] = false
}

type RunResult = { missing: boolean; code: number | null; signal: string | null }

/** Shell'siz ishga tushiradi (argumentlar massivi). Linux'da alohida jarayon
    guruhi — muddat tugaganda wrapper bilan birga soffice.bin ham o'ladi. */
function runOnce(bin: string, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const groupKill = process.platform !== "win32"
    let settled = false
    const child = spawn(bin, args, { stdio: "ignore", detached: groupKill }) // nosemgrep
    const finish = (result: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        if (groupKill && child.pid) process.kill(-child.pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch { /* allaqachon tugagan */ }
      finish({ missing: false, code: null, signal: "timeout" })
    }, timeoutMs)
    child.on("error", (err: NodeJS.ErrnoException) => finish({ missing: err.code === "ENOENT", code: null, signal: null }))
    child.on("exit", (code, signal) => finish({ missing: false, code, signal }))
  })
}

/** `absPath`ni LibreOffice bilan `format`ga (masalan "pdf", "txt:Text")
    o'giradi va natijani `destPath`ga yozadi. Muvaffaqiyatli bo'lsa true. */
export async function convertWithLibreOffice(absPath: string, format: string, destPath: string, timeoutMs = 45000): Promise<boolean> {
  const slot = await acquireSlot()
  let jobDir: string | null = null
  try {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "lms-lo-job-"))
    const outDir = jobDir
    const profileDir = path.join(os.tmpdir(), `lms-lo-profile-${slot}`)
    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--headless", "--norestore", "--convert-to", format, "--outdir", outDir, absPath,
    ]
    for (const bin of workingBin ? [workingBin] : CANDIDATES) {
      let result = await runOnce(bin, args, timeoutMs)
      if (result.missing) continue
      workingBin = bin
      // Yangi profil bilan birinchi ishga tushishda ba'zi versiyalar faqat
      // profilni tayyorlab 81 kodi bilan chiqadi — konvertatsiya qilinmaydi
      if (result.code === 81) result = await runOnce(bin, args, timeoutMs)

      // Natija kirish faylining nomi bilan, yangi kengaytma bilan yoziladi
      const produced = fs.readdirSync(outDir).find((name) => fs.statSync(path.join(outDir, name)).size > 0)
      if (!produced) {
        console.warn("%s konvertatsiya bo'lmadi (kod %s, signal %s): %s", LOG, String(result.code), String(result.signal), path.basename(absPath))
        return false
      }
      // .part orqali — yarim yozilgan fayl hech qachon tayyor deb berilmaydi
      const partPath = `${destPath}.part`
      fs.copyFileSync(path.join(outDir, produced), partPath) // nosemgrep
      fs.renameSync(partPath, destPath) // nosemgrep
      return true
    }
    console.warn("%s LibreOffice topilmadi (%s)", LOG, CANDIDATES.join(", "))
    return false
  } catch (err) {
    console.warn("%s konvertatsiya xatosi: %s", LOG, err instanceof Error ? err.message : String(err))
    return false
  } finally {
    if (jobDir) fs.rm(jobDir, { recursive: true, force: true }, () => undefined)
    releaseSlot(slot)
  }
}
