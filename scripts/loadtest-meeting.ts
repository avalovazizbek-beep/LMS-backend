/// <reference path="../src/types/wrtc.d.ts" />
/**
 * Meeting yuklama testi (load test) — bizning mediasoup + Socket.IO
 * serverimiz necha kishi va necha xonani bir vaqtda ko'tara olishini
 * HAQIQIY WebRTC ulanishlari bilan sinaydi (wrtc — soxta kamera/mikrofon
 * manbai orqali, haqiqiy talaba/o'qituvchi hisoblari kerak emas).
 *
 * O'RNATISH (bir martalik, faqat shu uchta paket qo'shiladi):
 *   npm install --save-dev wrtc mediasoup-client socket.io-client
 *
 * ISHGA TUSHIRISH — kichikdan boshlang:
 *   npx ts-node scripts/loadtest-meeting.ts --rooms=2 --perRoom=50 --producers=3
 *
 * Keyin asta kattalashtiring:
 *   npx ts-node scripts/loadtest-meeting.ts --rooms=5 --perRoom=100 --producers=5
 *   npx ts-node scripts/loadtest-meeting.ts --rooms=20 --perRoom=120 --producers=5
 *
 * MUHIM XAVFSIZLIK ESLATMASI:
 *   - Bu skript HAQIQIY ishlayotgan mediasoup serverga ulanadi va haqiqiy
 *     worker/router/port resurslarini band qiladi. FAQAT dars bo'lmagan
 *     vaqtda (kechqurun/tunda), real foydalanuvchilar meeting'da
 *     bo'lmagan paytda ishga tushiring.
 *   - Skriptni ISHLAB TURGAN SERVERNING O'ZIDA emas, imkon qadar BOSHQA
 *     mashinadan ishga tushirish tavsiya etiladi — aks holda soxta
 *     kamera/mikrofon generatsiyasi ham mediasoup bilan bitta CPU'ni
 *     baham ko'rib, natijani buzadi. Agar boshqa mashina yo'q bo'lsa,
 *     shu serverning o'zida ishlatish ham natija beradi, lekin CPU
 *     ko'rsatkichlarini o'qiganda buni hisobga oling.
 *   - `--socketUrl` orqali qaysi manzilga ulanishni tanlang: standart
 *     http://127.0.0.1:5000 — nginx'ni chetlab, to'g'ridan-to'g'ri
 *     backend'ga (localhost) ulanadi (eng "toza" sinov). Agar nginx/SSL
 *     qatlamini ham sinamoqchi bo'lsangiz --socketUrl=https://lms.sies.uz
 *     bering.
 *
 * NATIJANI QANDAY O'QISH:
 *   - "muvaffaqiyatli ulanish" soni kutilgan (rooms*perRoom) songa teng
 *     bo'lishi kerak. Kam bo'lsa — xatolar ro'yxatida sabab yozilgan
 *     (port tugashi, transport yaratilmasligi, timeout va h.k.).
 *   - "o'rtacha qo'shilish vaqti (join latency)" — necha soniyada odam
 *     xonaga to'liq ulanadi. 1-2 soniyagacha normal, undan sekinlashsa
 *     server siqilib qolayotganini bildiradi.
 */

// wrtc'ning turlari src/types/wrtc.d.ts'da e'lon qilingan (bu faylning
// o'zida emas — chunki bu fayl import/export ishlatadi, ya'ni TypeScript
// buni "modul" deb hisoblaydi, va shunday faylda `declare module "wrtc"`
// yozilsa, allaqachon mavjud (lekin turlari yo'q) modulni "kengaytirish"
// deb talqin qilinib, xatolik beradi).
//
// Backend tsconfig'ida "lib": ["ES2020"] — DOM turlari (shu jumladan
// MediaStreamTrack) yo'q. Bu skript uchun ular kerak emas, shuning uchun
// mediasoup-client'ga uzatiladigan "track"ni shu minimal shakl bilan
// belgilaymiz (haqiqiy runtime'da wrtc real MediaStreamTrack qaytaradi).
type FakeTrack = { addEventListener?: (event: string, cb: () => void) => void } & Record<string, unknown>

import "dotenv/config"
import wrtc from "wrtc"

// mediasoup-client brauzer muhitini kutadi (navigator, RTCPeerConnection...) —
// wrtc paketi shularni Node.js'da soxtalashtirib beradi. Device yaratilishidan
// OLDIN global qilib qo'yilishi shart.
;(global as unknown as Record<string, unknown>).RTCPeerConnection = wrtc.RTCPeerConnection
;(global as unknown as Record<string, unknown>).MediaStream = wrtc.MediaStream
;(global as unknown as Record<string, unknown>).MediaStreamTrack = wrtc.MediaStreamTrack

import { Device } from "mediasoup-client"
import type { types as MediasoupClientTypes } from "mediasoup-client"
import { io as ioClient, type Socket } from "socket.io-client"
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
const PER_ROOM = argNum("perRoom", 50)
const PRODUCERS_PER_ROOM = argNum("producers", 3) // o'qituvchidan tashqari qancha talaba video/audio yuboradi
const RAMP_MS = argNum("rampMs", 120) // har bir ishtirokchi ulanishi orasidagi tanaffus
const HOLD_SECONDS = argNum("holdSeconds", 90)
const SOCKET_URL = argStr("socketUrl", "http://127.0.0.1:5000")
const DEMO_GROUP_ID = argNum("groupId", 9901) // seed-demo.ts'dagi DEMO-101

/* ── mediasoup-client Device — Node muhitida handler avtomatik aniqlanmaydi ── */
function createDevice(): Device {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Chrome111 } = require("mediasoup-client/lib/handlers/Chrome111")
    return new Device({ handlerFactory: Chrome111.createFactory() })
  } catch {
    try {
      return new (Device as unknown as new (opts: { handlerName: string }) => Device)({ handlerName: "Chrome111" })
    } catch (err) {
      console.error(
        "[loadtest] Device yaratib bo'lmadi — o'rnatilgan mediasoup-client versiyasi boshqa yo'l talab qilishi mumkin.",
        "package.json'dagi versiyani tekshirib, node_modules/mediasoup-client/lib/handlers/ papkasidagi mavjud sinf nomini shu yerga qo'ying.",
        err
      )
      throw err
    }
  }
}

/* ── Soxta video/audio manba (haqiqiy kamera/mikrofon shart emas) ──────── */
function createFakeVideoTrack(): FakeTrack {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source = new (wrtc as any).nonstandard.RTCVideoSource()
  const track = source.createTrack()
  const width = 320
  const height = 240
  const data = new Uint8ClampedArray((width * height * 3) / 2) // I420
  data.fill(128)
  const interval = setInterval(() => {
    try {
      source.onFrame({ width, height, data })
    } catch {
      clearInterval(interval)
    }
  }, 1000 / 10) // 10 fps — generatorning o'z CPU sarfini past tutish uchun
  track.addEventListener?.("ended", () => clearInterval(interval))
  return track
}

function createFakeAudioTrack(): FakeTrack {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const source = new (wrtc as any).nonstandard.RTCAudioSource()
  const track = source.createTrack()
  const sampleRate = 48000
  const samplesPerFrame = sampleRate / 100 // 10ms freym
  const interval = setInterval(() => {
    try {
      source.onData({
        samples: new Int16Array(samplesPerFrame * 2), // jimlik, stereo
        sampleRate,
        bitsPerSample: 16,
        channelCount: 2,
        numberOfFrames: samplesPerFrame,
      })
    } catch {
      clearInterval(interval)
    }
  }, 10)
  track.addEventListener?.("ended", () => clearInterval(interval))
  return track
}

/* ── Socket ack yordamchisi (frontenddagi bilan bir xil naqsh) ─────────── */
function emitAck<T = unknown>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (res: { success: boolean; data?: T; error?: string }) => {
      if (res?.success) resolve(res.data as T)
      else reject(new Error(res?.error || `${event} muvaffaqiyatsiz`))
    })
  })
}

interface SimResult {
  ok: boolean
  error?: string
  joinMs?: number
}

/* ── Bitta simulyatsiya qilingan ishtirokchi ───────────────────────────── */
async function simulateParticipant(meeting: MeetingRecord, user: MeetingUser, shouldProduce: boolean): Promise<{ result: Promise<SimResult>; close: () => void }> {
  const startedAt = Date.now()
  const token = signJoinToken(meeting, user)
  const socket: Socket = ioClient(SOCKET_URL, {
    auth: { joinToken: token },
    transports: ["websocket"],
    reconnection: false,
    timeout: 15000,
  })

  let settled = false
  let resolveFn: (r: SimResult) => void
  const result = new Promise<SimResult>((resolve) => {
    resolveFn = resolve
  })
  const finish = (r: SimResult) => {
    if (settled) return
    settled = true
    resolveFn(r)
  }

  socket.on("connect_error", (err: Error) => finish({ ok: false, error: `connect_error: ${err.message}` }))

  socket.on("meeting:joined", async (payload: { rtpCapabilities: MediasoupClientTypes.RtpCapabilities; producers: Array<{ producerId: string; kind: "audio" | "video" }> }) => {
    try {
      const device = createDevice()
      await device.load({ routerRtpCapabilities: payload.rtpCapabilities })

      const recvParams = await emitAck<MediasoupClientTypes.TransportOptions>(socket, "mediasoup:createTransport", { direction: "recv" })
      const recvTransport = device.createRecvTransport(recvParams)
      recvTransport.on("connect", ({ dtlsParameters }, cb, eb) => {
        emitAck(socket, "mediasoup:connectTransport", { transportId: recvTransport.id, dtlsParameters }).then(() => cb()).catch(eb)
      })

      const consumeOne = async (producer: { producerId: string }) => {
        try {
          const data = await emitAck<{ id: string; producerId: string; kind: "audio" | "video"; rtpParameters: MediasoupClientTypes.RtpParameters }>(
            socket,
            "mediasoup:consume",
            { transportId: recvTransport.id, producerId: producer.producerId, rtpCapabilities: device.rtpCapabilities }
          )
          await recvTransport.consume({ id: data.id, producerId: data.producerId, kind: data.kind, rtpParameters: data.rtpParameters })
          await emitAck(socket, "mediasoup:resumeConsumer", { consumerId: data.id })
        } catch {
          // Yuklama testida bitta consume xatosi butun sinovni to'xtatmasin
        }
      }

      for (const producer of payload.producers ?? []) await consumeOne(producer)
      socket.on("mediasoup:newProducer", consumeOne)

      if (shouldProduce) {
        const sendParams = await emitAck<MediasoupClientTypes.TransportOptions>(socket, "mediasoup:createTransport", { direction: "send" })
        const sendTransport = device.createSendTransport(sendParams)
        sendTransport.on("connect", ({ dtlsParameters }, cb, eb) => {
          emitAck(socket, "mediasoup:connectTransport", { transportId: sendTransport.id, dtlsParameters }).then(() => cb()).catch(eb)
        })
        sendTransport.on("produce", ({ kind, rtpParameters, appData }, cb, eb) => {
          emitAck<{ id: string }>(socket, "mediasoup:produce", { transportId: sendTransport.id, kind, rtpParameters, source: (appData as { source?: string })?.source })
            .then(({ id }) => cb({ id }))
            .catch(eb)
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await sendTransport.produce({ track: createFakeAudioTrack() as any, appData: { source: "mic" } })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await sendTransport.produce({ track: createFakeVideoTrack() as any, appData: { source: "camera" } })
      }

      finish({ ok: true, joinMs: Date.now() - startedAt })
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  return { result, close: () => socket.disconnect() }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  await initDatabase()

  console.log(`\n=== Meeting yuklama testi ===`)
  console.log(`Xonalar: ${ROOMS}, har birida: ${PER_ROOM} kishi (${PRODUCERS_PER_ROOM} tasi + o'qituvchi video/audio yuboradi)`)
  console.log(`Jami ulanish: ${ROOMS * PER_ROOM}`)
  console.log(`Socket URL: ${SOCKET_URL}`)
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
      {
        title: `[LOADTEST] Xona ${i + 1}`,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        groupIds: [DEMO_GROUP_ID],
      },
      teacherUser
    )
    const full = await getMeeting(created.id)
    if (full) meetings.push(full)
  }
  console.log(`${meetings.length} ta test xonasi yaratildi.\n`)

  const closers: Array<() => void> = []
  const results: SimResult[] = []
  let started = 0
  const totalParticipants = meetings.length * PER_ROOM

  for (const meeting of meetings) {
    // O'qituvchi — doim video/audio yuboradi
    const teacherSim = await simulateParticipant(meeting, teacherUser, true)
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
      const sim = await simulateParticipant(meeting, student, isProducer)
      closers.push(sim.close)
      sim.result.then((r) => results.push(r))
      started++
      if (started % 20 === 0) {
        console.log(`... ${started}/${totalParticipants} ulanish boshlandi`)
      }
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
  closers.forEach((close) => close())
  await sleep(1000)
  process.exit(0)
}

main().catch((err) => {
  console.error("[loadtest] xato:", err)
  process.exit(1)
})
