/**
 * Meeting yuklama testi (load test) — bizning mediasoup + Socket.IO
 * serverimiz necha kishi va necha xonani bir vaqtda ko'tara olishini
 * HAQIQIY brauzer (headless Chrome, Puppeteer orqali) bilan sinaydi.
 *
 * Nega wrtc emas, Chrome: birinchi versiya wrtc (Node.js'dagi soxta
 * WebRTC kutubxonasi) bilan yozilgan edi, lekin u ishga tushganda native
 * darajada cho'kib qoldi ("Aborted") — wrtc eskirgan, zamonaviy Node bilan
 * mos emas. Shu sabab endi haqiqiy Chrome ishlatiladi — u chinakam
 * WebRTC'ni to'liq, ishonchli qo'llab-quvvatlaydi va `--use-fake-device-
 * for-media-stream` bayrog'i bilan soxta kamera/mikrofon (test rasm +
 * ohang) avtomatik beradi, hech qanday qo'shimcha "media generator" kodi
 * kerak emas.
 *
 * Har bir ishtirokchi — alohida Chrome tab (bitta umumiy brauzer
 * ichida), `my-app/public/loadtest-client.html` sahifasini ochadi (bu
 * sahifa frontendning o'zida joylashgan, hech qanday menyudan
 * bog'lanmagan, faqat shu test uchun). O'sha sahifa socket.io-client +
 * mediasoup-client'ni CDN'dan yuklaydi va HAQIQIY meeting oqimini
 * bajaradi.
 *
 * O'RNATISH (bir martalik):
 *   npm install --save-dev puppeteer
 *
 * ISHGA TUSHIRISH — kichikdan boshlang:
 *   npx ts-node scripts/loadtest-meeting.ts --rooms=2 --perRoom=20 --producers=3
 *
 * Keyin asta kattalashtiring:
 *   npx ts-node scripts/loadtest-meeting.ts --rooms=2 --perRoom=100 --producers=5
 *   npx ts-node scripts/loadtest-meeting.ts --rooms=20 --perRoom=120 --producers=5
 *
 * MUHIM:
 *   - Har bir Chrome tab haqiqiy brauzer jarayoni kabi RAM/CPU ishlatadi
 *     (wrtc'dagidan OG'IRROQ, lekin ISHONCHLI). Shu sabab --perRoom'ni
 *     ehtiyotkorlik bilan, asta-sekin oshiring va `htop`/`free -h` orqali
 *     serverni kuzatib turing.
 *   - `--frontendUrl` — standart https://lms.sies.uz (backend'ning
 *     .env'idagi FRONTEND_URL bilan ANIQ bir xil bo'lishi SHART, aks
 *     holda Socket.IO CORS ulanishni rad etadi).
 *   - FAQAT dars bo'lmagan vaqtda ishga tushiring.
 *
 * NATIJANI QANDAY O'QISH:
 *   - "muvaffaqiyatli ulanish" (rooms*perRoom)ga teng bo'lishi kerak.
 *   - "o'rtacha qo'shilish vaqti" 1-3 soniyagacha normal (Chrome tab
 *     ochilishi ham vaqt oladi, wrtc'dagidan biroz sekinroq bo'lishi
 *     tabiiy) — sekundlab cho'zilib ketsa, server siqilib qolayotganini
 *     bildiradi.
 */

import "dotenv/config"
import puppeteer, { type Browser, type Page } from "puppeteer"
import { initDatabase } from "../src/services/db"
import {
  createMeeting,
  getMeeting,
  signJoinToken,
  type MeetingUser,
  type MeetingRecord,
} from "../src/services/meetingStore"

/* ── CLI argumentlar ─────────────────────────────────────────────────── */
function argNum(name: string, def: number): number {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? Number(m.split("=")[1]) || def : def
}
function argStr(name: string, def: string): string {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`))
  return m ? m.split("=")[1] : def
}

const ROOMS = argNum("rooms", 2)
const PER_ROOM = argNum("perRoom", 20)
const PRODUCERS_PER_ROOM = argNum("producers", 3) // o'qituvchidan tashqari qancha talaba video/audio yuboradi
const RAMP_MS = argNum("rampMs", 250) // har bir ishtirokchi ulanishi orasidagi tanaffus
const HOLD_SECONDS = argNum("holdSeconds", 90)
// https://lms.sies.uz (nginx orqali, /socket.io/ location'i 127.0.0.1:5000'ga
// yo'naltiradi) — http://127.0.0.1:5000'ni to'g'ridan-to'g'ri berish HTTPS
// sahifadan (harness shu domenda ochiladi) "mixed content" sifatida
// brauzer tomonidan bloklanishi mumkin, real foydalanuvchi ham aynan shu
// (nginx orqali) yo'lni ishlatadi.
const SOCKET_URL = argStr("socketUrl", "https://lms.sies.uz")
const FRONTEND_URL = argStr("frontendUrl", "https://lms.sies.uz") // backend .env'idagi FRONTEND_URL bilan bir xil bo'lishi shart (CORS)
const DEMO_GROUP_ID = argNum("groupId", 9901) // seed-demo.ts'dagi DEMO-101
const JOIN_TIMEOUT_MS = argNum("joinTimeoutMs", 20000)

interface SimResult {
  ok: boolean
  error?: string
  joinMs?: number
}

async function simulateParticipant(browser: Browser, meeting: MeetingRecord, user: MeetingUser, shouldProduce: boolean, verbose = false): Promise<{ result: Promise<SimResult>; close: () => Promise<void> }> {
  const token = signJoinToken(meeting, user)
  const page: Page = await browser.newPage()
  if (verbose) {
    page.on("console", (msg) => console.log(`  [browser:${user.fullName}]`, msg.text()))
    page.on("pageerror", (err) => console.log(`  [browser:${user.fullName}] PAGE ERROR:`, err instanceof Error ? err.message : String(err)))
    page.on("requestfailed", (req) => console.log(`  [browser:${user.fullName}] REQUEST FAILED:`, req.url(), req.failure()?.errorText))
  }
  // Frontend production build'da NEXT_PUBLIC_BASE_PATH=/lms-samisi ostida
  // joylashgan (public/ fayllar ham shu yo'l ostida xizmat qiladi) — lekin
  // bu FAQAT sahifa manzilining YO'LIGA (path) tegishli, CORS Origin
  // header hali ham https://lms.sies.uz (path'siz), shuning uchun bu
  // FRONTEND_URL'ning CORS uchun to'g'ri qolishiga ta'sir qilmaydi.
  const url = `${FRONTEND_URL}/lms-samisi/loadtest-client.html?token=${encodeURIComponent(token)}&socketUrl=${encodeURIComponent(SOCKET_URL)}&produce=${shouldProduce ? "1" : "0"}`

  const result = (async (): Promise<SimResult> => {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: JOIN_TIMEOUT_MS })
    } catch (err) {
      return { ok: false, error: `goto failed: ${err instanceof Error ? err.message : String(err)}` }
    }

    const deadline = Date.now() + JOIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      // `globalThis` — brauzer ichida `window`ning o'zi, lekin bu fayl Node
      // (DOM'siz) muhit uchun tekshiriladi, shuning uchun `window` nomi
      // to'g'ridan-to'g'ri ishlatilmaydi.
      const status = await page.evaluate(() => (globalThis as unknown as { __loadtestResult?: SimResult }).__loadtestResult).catch(() => undefined)
      if (status?.ok) return status
      if (status && status.ok === false) return status
      await new Promise((r) => setTimeout(r, 300))
    }
    return { ok: false, error: "timeout — meeting:joined kelmadi" }
  })()

  return { result, close: () => page.close().catch(() => undefined) }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  await initDatabase()

  console.log(`\n=== Meeting yuklama testi (Puppeteer/Chrome) ===`)
  console.log(`Xonalar: ${ROOMS}, har birida: ${PER_ROOM} kishi (${PRODUCERS_PER_ROOM} tasi + o'qituvchi video/audio yuboradi)`)
  console.log(`Jami ulanish: ${ROOMS * PER_ROOM}`)
  console.log(`Socket URL: ${SOCKET_URL}, Frontend URL: ${FRONTEND_URL}`)
  console.log(`Ushlab turish vaqti: ${HOLD_SECONDS}s\n`)

  const teacherUser: MeetingUser = {
    id: 950100,
    fullName: "Load Test O'qituvchi",
    role: "teacher",
    groupId: null,
    teacherGroupIds: [DEMO_GROUP_ID],
  }

  const meetings: MeetingRecord[] = []
  for (let i = 0; i < ROOMS; i++) {
    const start = new Date()
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000)
    const created = await createMeeting(
      { title: `[LOADTEST] Xona ${i + 1}`, startTime: start.toISOString(), endTime: end.toISOString(), groupIds: [DEMO_GROUP_ID] },
      teacherUser
    )
    const full = await getMeeting(created.id)
    if (full) meetings.push(full)
  }
  console.log(`${meetings.length} ta test xonasi yaratildi.\n`)

  console.log("Chrome ishga tushmoqda...")
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  })

  const closers: Array<() => Promise<void>> = []
  const results: SimResult[] = []
  let started = 0
  const totalParticipants = meetings.length * PER_ROOM

  for (const meeting of meetings) {
    const teacherSim = await simulateParticipant(browser, meeting, teacherUser, true)
    closers.push(teacherSim.close)
    teacherSim.result.then((r) => results.push(r))
    started++
    await sleep(RAMP_MS)

    for (let s = 0; s < PER_ROOM - 1; s++) {
      const isProducer = s < PRODUCERS_PER_ROOM
      const student: MeetingUser = {
        id: 950200 + meeting.id * 1000 + s,
        fullName: `Load Test Talaba ${s + 1}`,
        role: "student",
        groupId: DEMO_GROUP_ID,
        teacherGroupIds: [],
      }
      const sim = await simulateParticipant(browser, meeting, student, isProducer)
      closers.push(sim.close)
      sim.result.then((r) => results.push(r))
      started++
      if (started % 10 === 0) console.log(`... ${started}/${totalParticipants} tab ochildi`)
      await sleep(RAMP_MS)
    }
  }

  console.log(`\nHammasi ulanishga urinmoqda, ${HOLD_SECONDS}s kutamiz...\n`)
  await sleep(HOLD_SECONDS * 1000)

  const ok = results.filter((r) => r.ok)
  const failed = results.filter((r) => !r.ok)
  const avgJoinMs = ok.length ? Math.round(ok.reduce((a, r) => a + (r.joinMs ?? 0), 0) / ok.length) : 0
  const maxJoinMs = ok.length ? Math.max(...ok.map((r) => r.joinMs ?? 0)) : 0

  console.log(`\n=== NATIJA ===`)
  console.log(`Muvaffaqiyatli ulandi: ${ok.length}/${totalParticipants}`)
  console.log(`Muvaffaqiyatsiz: ${failed.length}/${totalParticipants}`)
  console.log(`O'rtacha qo'shilish vaqti: ${avgJoinMs}ms, eng sekini: ${maxJoinMs}ms`)
  if (failed.length) {
    const errorCounts = new Map<string, number>()
    failed.forEach((f) => errorCounts.set(f.error ?? "noma'lum", (errorCounts.get(f.error ?? "noma'lum") ?? 0) + 1))
    console.log(`\nXatolar:`)
    errorCounts.forEach((count, err) => console.log(`  ${count}x — ${err}`))
  }

  console.log(`\nUlanishlarni yopyapmiz...`)
  await Promise.all(closers.map((close) => close()))
  await browser.close()
  process.exit(0)
}

main().catch((err) => {
  console.error("[loadtest] xato:", err)
  process.exit(1)
})
