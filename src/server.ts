import "dotenv/config"
import http from "http"
import express from "express"
import cors from "cors"
import { Server as SocketIOServer } from "socket.io"
import type { types as MediasoupTypes } from "mediasoup"

import authRoutes from "./routes/auth"
import usersRoutes from "./routes/users"
import groupsRoutes from "./routes/groups"
import examsRoutes from "./routes/exams"
import financeRoutes from "./routes/finance"
import documentsRoutes from "./routes/documents"
import meetingsRoutes, { setSocketIO } from "./routes/meetings"
import meetingInternalRoutes from "./routes/meetingInternal"
import localResourcesRoutes from "./routes/localResources"
import notificationsRoutes from "./routes/notifications"
import boardRoutes from "./routes/board"
import hemisRoutes from "./routes/hemis"
import teachingRoutes from "./routes/teaching"
import faceRoutes from "./routes/face"
import adminRoutes from "./routes/admin"
import announcementsRoutes from "./routes/announcements"
import reeduRoutes from "./routes/reedu"
import plagiarismRoutes from "./routes/plagiarism"
import supportRoutes from "./routes/support"
import photosRoutes from "./routes/photos"
import zoomRoutes, { zoomWebhookHandler } from "./routes/zoom"
import { startNotificationScheduler } from "./services/notificationScheduler"
import googleMeetRoutes from "./routes/googleMeet"
import {
  attendanceElapsedSeconds,
  getAttendance,
  getAttendanceMode,
  getAttendanceThresholdSeconds,
  getMeeting,
  getPermissions,
  joinMeeting,
  leaveMeeting,
  toMeetingResponse,
  verifyJoinToken,
  type MeetingUser,
} from "./services/meetingStore"
import { publicResourcePath } from "./services/localResourceStore"
import { initDatabase } from "./services/db"
import { runFullHemisSync } from "./services/hemisSync"
import { startCertificateSweep } from "./services/certificateStore"
import { startVideoTranscoder } from "./services/videoTranscode"
import * as mediasoupService from "./services/mediasoupService"

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err)
})

const app = express()
// Nginx/reverse-proxy ortida haqiqiy klient IP'sini X-Forwarded-For'dan olish uchun
// (audit log yozuvlari uchun kerak — aks holda hammasi proksi IP'si bo'lib qolardi)
app.set("trust proxy", true)
// "X-Powered-By: Express" texnologiyani oshkor qiladi; qolgan sarlavhalar —
// audit skanerlari tekshiradigan asosiy himoyalar (MIME sniffing, iframe).
app.disable("x-powered-by")
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("X-Frame-Options", "SAMEORIGIN")
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin")
  next()
})
const PORT = process.env.PORT || 5000
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || "http://localhost:3000"
const ALLOWED_ORIGINS = [
  FRONTEND_ORIGIN,
  "http://localhost:3000",
  "http://localhost:3001",
  // Ma'lum bo'lgan real frontend domenlari — FRONTEND_URL noto'g'ri
  // sozlansa ham productionda ishlab turishi kafolatlanishi uchun.
  "https://lms.sies.uz",
  "https://tyutorkpi.sies.uz",
]

app.use(cors({
  origin: (origin, callback) => {
    // VAQTINCHA: hamma manzilga ruxsat — cheklov production login'ni
    // buzgani aniqlandi (haqiqiy Origin header kutilganidan farq qilgan
    // bo'lishi mumkin). Xavfsizroq cheklovni keyinroq, aniq Origin
    // qiymatini log qilib tekshirgandan so'ng qayta qo'shamiz.
    callback(null, true)
  },
  credentials: true,
}))
// Zoom webhook imzosi xom body bo'yicha tekshiriladi — JSON parserdan oldin
app.post("/api/integrations/zoom/webhook", express.raw({ type: "*/*", limit: "1mb" }), zoomWebhookHandler)
app.use(express.json({ limit: "25mb" }))
app.use(express.urlencoded({ extended: true }))
app.use("/uploads", express.static(publicResourcePath(), {
  setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
}))

app.use("/api/auth", authRoutes)
app.use("/api/users", usersRoutes)
app.use("/api/groups", groupsRoutes)
app.use("/api/exams", examsRoutes)
app.use("/api/finance", financeRoutes)
app.use("/api/documents", documentsRoutes)
app.use("/api/meetings", meetingsRoutes)
app.use("/api/internal", meetingInternalRoutes)
app.use("/api/local-resources", localResourcesRoutes)
app.use("/api/notifications", notificationsRoutes)
app.use("/api/board", boardRoutes)
app.use("/api/hemis", hemisRoutes)
app.use("/api/teaching", teachingRoutes)
app.use("/api/face", faceRoutes)
app.use("/api/admin", adminRoutes)
app.use("/api/announcements", announcementsRoutes)
app.use("/api/reedu", reeduRoutes)
app.use("/api/plagiarism", plagiarismRoutes)
app.use("/api/support", supportRoutes)
app.use("/api/photos", photosRoutes)
app.use("/api/integrations/zoom", zoomRoutes)
app.use("/api/integrations/google", googleMeetRoutes)

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    status: "ok",
    service: "meeting-backend",
    timestamp: new Date().toISOString(),
  })
})

app.get("/api/health", (_req, res) => {
  res.json({ success: true, message: "LMS API ishlamoqda", timestamp: new Date().toISOString() })
})

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/uploads") || req.path === "/health") {
    next()
    return
  }

  // "//evil.com" kabi yo'l new URL() da boshqa domenga aylanadi (open redirect) —
  // boshidagi barcha / va \ olib tashlanib, natija faqat frontend domenida qoladi
  const target = new URL("/" + req.originalUrl.replace(/^[\/\\]+/, ""), FRONTEND_ORIGIN)
  if (target.origin !== new URL(FRONTEND_ORIGIN).origin) {
    res.status(400).end()
    return
  }
  res.redirect(target.toString()) // nosemgrep
})

async function participantPayload(meetingId: number) {
  return (await getAttendance(meetingId))
    .filter((summary) => summary.currentlyInMeeting)
    .map((summary) => ({
      userId: summary.userId,
      fullName: summary.fullName,
      groupId: summary.groupId,
      joinedAt: summary.firstJoinedAt,
      totalSeconds: summary.totalSeconds,
      status: "live",
    }))
}

type SocketChatMessage = {
  id: string
  meetingId: number
  userId: number
  fullName: string
  message: string
  text: string
  createdAt: string
}

const chatMessagesByMeeting = new Map<number, SocketChatMessage[]>()

function getChatMessages(meetingId: number) {
  return chatMessagesByMeeting.get(meetingId) ?? []
}

function pushChatMessage(message: SocketChatMessage) {
  const messages = [...getChatMessages(message.meetingId), message].slice(-100)
  chatMessagesByMeeting.set(message.meetingId, messages)
  return message
}

/* ── Katta darslar (80–120 kishi) uchun ──────────────────────────────────
   Har kirish/chiqishda butun xonaga to'liq ishtirokchilar ro'yxatini
   yuborish 120 kishilik xonada ~120² xabar beradi — ro'yxat 1,5 s ichidagi
   o'zgarishlar yig'ilib bir marta yuboriladi (participant:joined/left
   hodisalari esa darhol ketadi). */
const PARTICIPANTS_DEBOUNCE_MS = 1500
const participantsTimers = new Map<number, ReturnType<typeof setTimeout>>()

/* Talaba kamerasi serverga video sifatida yuborilmaydi (o'z qurilmasida
   qoladi — Face ID davomati u yerda ishlaydi). O'qituvchi talabalarni
   ko'rishi uchun har ~20 soniyada kichik JPEG surat keladi (~5–10 KB) va
   faqat darsni boshqaruvchilarga uzatiladi. Xotirada oxirgisi saqlanadi. */
type ParticipantSnapshot = { socketId: string; userId: number; fullName: string; groupId: number | null; image: string; at: number }
const snapshotsByMeeting = new Map<number, Map<string, ParticipantSnapshot>>()
const SNAPSHOT_MAX_CHARS = 60_000
const SNAPSHOT_MIN_INTERVAL_MS = 8_000

/* O'qituvchi talabalarni jonli ko'rishi: "Kameralar" panelida ko'rinib turgan
   sahifadagi (≤12) talabalar va asosiy ekrandagi talaba — faqat shular
   past sifatli (≈320×180, ~0,2 Mbit/s) kamera yuboradi va uni FAQAT
   o'qituvchi(lar) oladi. Qolganlar videoni umuman yubormaydi. */
const MAX_WATCH_PER_MANAGER = 20
const MAX_WATCHED_PER_MEETING = 30
const watchersByMeeting = new Map<number, Map<string, number[]>>()

function watchedUserIds(meetingId: number): Set<number> {
  const union = new Set<number>()
  for (const ids of watchersByMeeting.get(meetingId)?.values() ?? []) {
    for (const id of ids) {
      if (union.size >= MAX_WATCHED_PER_MEETING) return union
      union.add(id)
    }
  }
  return union
}

function dropWatcher(meetingId: number, socketId: string) {
  const byMeeting = watchersByMeeting.get(meetingId)
  if (!byMeeting?.delete(socketId)) return false
  if (!byMeeting.size) watchersByMeeting.delete(meetingId)
  return true
}

function dropSnapshot(meetingId: number, socketId: string) {
  const byMeeting = snapshotsByMeeting.get(meetingId)
  if (!byMeeting) return
  byMeeting.delete(socketId)
  if (!byMeeting.size) snapshotsByMeeting.delete(meetingId)
}

const httpServer = http.createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: { origin: FRONTEND_ORIGIN, credentials: true },
})
setSocketIO(io)

/** Har bir talabaga "kamerangizni jonli yuboring / to'xtating" deydi —
 *  o'qituvchilarning ko'rish ro'yxatiga qarab. To'xtatilganda server ham
 *  producer'ni yopadi (klient kechiksa ham o'qituvchiga trafik ketmasin). */
function syncLiveCameras(meetingId: number) {
  const watched = watchedUserIds(meetingId)
  for (const socketId of io.sockets.adapter.rooms.get(`meeting:${meetingId}`) ?? []) {
    const peerSocket = io.sockets.sockets.get(socketId)
    const peerUser = peerSocket?.data.user as MeetingUser | undefined
    if (!peerSocket || !peerUser || peerUser.role !== "student") continue
    const on = watched.has(peerUser.id)
    if (Boolean(peerSocket.data.liveCamera) === on) continue
    peerSocket.data.liveCamera = on
    peerSocket.emit("meeting:liveCamera", { on })
    if (!on) {
      for (const producerId of mediasoupService.closeProducersBySource(meetingId, socketId, "camera")) {
        io.to(`meeting:${meetingId}:managers`).emit("mediasoup:producerClosed", { producerId, socketId })
      }
    }
  }
}

function socketPeerPayload(room: string, excludeSocketId?: string) {
  const socketIds = io.sockets.adapter.rooms.get(room) ?? new Set<string>()
  return Array.from(socketIds)
    .filter((socketId) => socketId !== excludeSocketId)
    .map((socketId) => {
      const peerSocket = io.sockets.sockets.get(socketId)
      const peerUser = peerSocket?.data.user as MeetingUser | undefined
      if (!peerUser) return null
      return {
        socketId,
        userId: peerUser.id,
        fullName: peerUser.fullName,
        role: peerUser.role,
        groupId: peerUser.groupId,
        mediaState: peerSocket?.data.mediaState ?? null,
      }
    })
    .filter((peer): peer is NonNullable<typeof peer> => Boolean(peer))
}

io.use(async (socket, next) => {
  const rawToken =
    socket.handshake.auth?.joinToken ??
    socket.handshake.auth?.token ??
    socket.handshake.headers["x-join-token"] ??
    socket.handshake.query?.token
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken

  if (!token || typeof token !== "string") {
    next(new Error("Join token topilmadi"))
    return
  }

  try {
    const payload = verifyJoinToken(token)
    const meeting = await getMeeting(payload.meetingId)

    if (payload.type !== "meeting-join" || !meeting) {
      next(new Error("Join token yaroqsiz"))
      return
    }

    if (meeting.status === "ended" || meeting.status === "cancelled") {
      next(new Error("Meeting yakunlangan"))
      return
    }

    const user: MeetingUser = {
      id: payload.userId,
      fullName: payload.fullName,
      role: payload.role,
      groupId: payload.groupId,
      teacherGroupIds: [],
    }

    socket.data.meetingId = payload.meetingId
    socket.data.user = user
    next()
  } catch {
    next(new Error("Join token yaroqsiz"))
  }
})

io.on("connection", async (socket) => {
  const meetingId = socket.data.meetingId as number
  const user = socket.data.user as MeetingUser
  const meeting = await getMeeting(meetingId)

  if (!meeting) {
    socket.disconnect(true)
    return
  }

  const room = `meeting:${meetingId}`

  // Bitta foydalanuvchi — bitta ulanish. Boshqa oyna/qurilmadagi (yoki uzilgan
  // tarmoqdan qolib ketgan) eski ulanishlari yopiladi: aks holda yangi ulanish
  // eskisining mikrofonini "boshqa ishtirokchi" deb qabul qiladi — odam o'z
  // ovozini kechikish bilan qayta eshitadi, boshqalar esa uni bir necha
  // nusxada eshitadi (aks-sado va shovqin).
  if (user.id) {
    for (const other of await io.in(room).fetchSockets()) {
      const otherUser = other.data.user as MeetingUser | undefined
      if (other.id === socket.id || !otherUser || otherUser.id !== user.id || otherUser.role !== user.role) continue
      other.data.replaced = true
      dropSnapshot(meetingId, other.id)
      dropWatcher(meetingId, other.id)
      for (const producerId of mediasoupService.cleanupPeer(meetingId, other.id)) {
        io.to(room).emit("mediasoup:producerClosed", { producerId, socketId: other.id })
      }
      io.to(room).emit("participant:left", {
        socketId: other.id, userId: user.id, fullName: user.fullName, role: user.role, groupId: user.groupId, status: "left",
      })
      other.emit("meeting:replaced")
      other.leave(room)
      other.disconnect(true)
    }
  }

  await joinMeeting(meeting, user)
  socket.join(room)
  socket.data.meetingJoined = true
  socket.data.mediaState = { cameraEnabled: false, micEnabled: false, screenSharing: false }
  await mediasoupService.registerPeer(meetingId, {
    socketId: socket.id,
    userId: user.id,
    fullName: user.fullName,
    role: user.role,
    groupId: user.groupId,
  })
  // O'qituvchi bu talabani allaqachon ko'rmoqchi bo'lsa (qayta ulanish)
  if (user.role === "student") syncLiveCameras(meetingId)

  const emitParticipantsNow = async () => {
    io.to(room).emit("participants", await participantPayload(meetingId))
  }
  const emitParticipants = async () => {
    if (participantsTimers.has(meetingId)) return
    participantsTimers.set(meetingId, setTimeout(() => {
      participantsTimers.delete(meetingId)
      void emitParticipantsNow().catch(() => undefined)
    }, PARTICIPANTS_DEBOUNCE_MS))
  }

  // Darsni boshqaruvchilar (o'qituvchi/admin) — talabalar suratlari faqat ularga
  const managersRoom = `meeting:${meetingId}:managers`
  const isManager = toMeetingResponse(meeting, user).permissions.canManageMeeting
  if (isManager) {
    socket.join(managersRoom)
    const existing = snapshotsByMeeting.get(meetingId)
    if (existing?.size) socket.emit("meeting:snapshots", Array.from(existing.values()))
  }

  // "Avtomatik" davomat: talabaga davomat vaqti qancha qolganini aytamiz —
  // tugagach klient kamera va mikrofonni o'chiradi (xalaqit bermasligi uchun)
  const attendanceWindow = user.role === "student" && (await getAttendanceMode()) === "auto"
    ? await (async () => {
        const windowSeconds = await getAttendanceThresholdSeconds()
        const elapsed = await attendanceElapsedSeconds(meetingId, user.id)
        return { windowSeconds, remainingSeconds: Math.max(0, windowSeconds - elapsed) }
      })().catch(() => null)
    : null

  const joinedPayload = async () => {
    const response = toMeetingResponse(meeting, user)
    return {
      attendanceWindow,
      meetingId,
      user,
      meeting: response,
      permissions: response.permissions,
      participants: await participantPayload(meetingId),
      peers: socketPeerPayload(room, socket.id),
      messages: getChatMessages(meetingId),
      rtpCapabilities: await mediasoupService.getRouterRtpCapabilities(meetingId),
      // Talabalarning jonli kamerasi faqat o'qituvchiga ko'rinadi
      producers: mediasoupService.listExistingProducers(meetingId, socket.id)
        .filter((p) => isManager || !(p.role === "student" && p.kind === "video" && p.source === "camera")),
    }
  }

  socket.emit("meeting:joined", await joinedPayload())
  socket.to(room).emit("participant:joined", {
    socketId: socket.id,
    userId: user.id,
    fullName: user.fullName,
    role: user.role,
    groupId: user.groupId,
  })
  await emitParticipants()

  socket.on("meeting:join", async (payloadOrAck: unknown, maybeAck?: unknown) => {
    const ack = typeof payloadOrAck === "function" ? payloadOrAck : maybeAck
    socket.data.meetingJoined = true
    const payload = await joinedPayload()
    socket.emit("meeting:joined", payload)
    if (typeof ack === "function") {
      ack({ success: true, data: payload })
    }
  })

  const handleChatMessage = (message: unknown, maybeAck?: unknown) => {
    const record = message && typeof message === "object" ? (message as Record<string, unknown>) : {}
    const rawText = typeof message === "string" ? message : record.message ?? record.text
    const text = typeof rawText === "string" ? rawText.trim() : ""
    if (!text) return

    const savedMessage = pushChatMessage({
      id: `${Date.now()}-${socket.id}`,
      meetingId,
      userId: user.id,
      fullName: user.fullName,
      message: text.slice(0, 1000),
      text: text.slice(0, 1000),
      createdAt: new Date().toISOString(),
    })

    io.to(room).emit("chat:message", savedMessage)
    io.to(room).emit("chat:newMessage", savedMessage)
    if (typeof maybeAck === "function") {
      maybeAck({ success: true, data: savedMessage })
    }
  }

  socket.on("chat:message", handleChatMessage)
  socket.on("chat:send", handleChatMessage)

  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

  socket.on("mediasoup:createTransport", async (_payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const params = await mediasoupService.createWebRtcTransport(meetingId, socket.id)
      ack({ success: true, data: params })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Transport yaratishda xatolik" })
    }
  })

  socket.on("mediasoup:connectTransport", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const record = asRecord(payload)
      const transportId = typeof record.transportId === "string" ? record.transportId : null
      if (!transportId || !record.dtlsParameters) throw new Error("transportId/dtlsParameters kerak")
      await mediasoupService.connectTransport(
        meetingId,
        socket.id,
        transportId,
        record.dtlsParameters as MediasoupTypes.DtlsParameters
      )
      ack({ success: true })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Transport ulanishida xatolik" })
    }
  })

  socket.on("mediasoup:produce", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const record = asRecord(payload)
      const transportId = typeof record.transportId === "string" ? record.transportId : null
      const kind = record.kind === "audio" || record.kind === "video" ? record.kind : null
      const source =
        record.source === "camera" || record.source === "mic" || record.source === "screen"
          ? record.source
          : kind === "audio" ? "mic" : "camera"
      if (!transportId || !kind || !record.rtpParameters) throw new Error("transportId/kind/rtpParameters kerak")

      // Ma'ruza rejimi: talaba kamerasi serverga yuborilmaydi — 120 kishilik
      // darsda har bir talaba videosi boshqa 119 kishiga tarqatilsa server va
      // talabalar interneti ko'tarmaydi. Kamera talabaning o'z qurilmasida
      // qoladi (Face ID davomati), o'qituvchi esa suratlarni ko'radi.
      if (user.role === "student" && source === "camera" && !socket.data.liveCamera) {
        throw new Error("Talaba kamerasi faqat o'qituvchi ko'rayotganda yuboriladi (ma'ruza rejimi)")
      }

      const permissions = getPermissions(user, meeting)
      const denied =
        (source === "camera" && !permissions.allowCamera) ||
        (source === "mic" && !permissions.allowMicrophone) ||
        (source === "screen" && !permissions.allowScreenShare)
      if (denied) throw new Error("Bu turdagi media uchun ruxsat yo'q")

      const producerId = await mediasoupService.produce(meetingId, socket.id, {
        transportId,
        kind,
        rtpParameters: record.rtpParameters as MediasoupTypes.RtpParameters,
        source,
      })
      ack({ success: true, data: { id: producerId } })
      const studentCamera = user.role === "student" && source === "camera"
      socket.to(studentCamera ? managersRoom : room).emit("mediasoup:newProducer", {
        producerId,
        socketId: socket.id,
        userId: user.id,
        fullName: user.fullName,
        role: user.role,
        groupId: user.groupId,
        kind,
        source,
      })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Media yuborishda xatolik" })
    }
  })

  socket.on("mediasoup:consume", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const record = asRecord(payload)
      const transportId = typeof record.transportId === "string" ? record.transportId : null
      const producerId = typeof record.producerId === "string" ? record.producerId : null
      if (!transportId || !producerId || !record.rtpCapabilities) throw new Error("transportId/producerId/rtpCapabilities kerak")
      const owner = mediasoupService.getProducerSummary(meetingId, producerId)
      if (!isManager && owner && owner.role === "student" && owner.kind === "video" && owner.source === "camera") {
        throw new Error("Talaba kamerasini faqat o'qituvchi ko'radi")
      }

      const data = await mediasoupService.consume(
        meetingId,
        socket.id,
        { transportId, producerId, rtpCapabilities: record.rtpCapabilities as MediasoupTypes.RtpCapabilities },
        // Producer yopilsa (ko'rish to'xtatildi / egasi chiqdi) — shu klientga aniq xabar
        () => { if (owner) socket.emit("mediasoup:producerClosed", { producerId, socketId: owner.socketId }) }
      )
      ack({ success: true, data })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Media qabul qilishda xatolik" })
    }
  })

  socket.on("mediasoup:resumeConsumer", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const consumerId = typeof asRecord(payload).consumerId === "string" ? (asRecord(payload).consumerId as string) : null
      if (!consumerId) throw new Error("consumerId kerak")
      await mediasoupService.resumeConsumer(meetingId, socket.id, consumerId)
      ack({ success: true })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Xatolik" })
    }
  })

  socket.on("mediasoup:pauseProducer", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const producerId = typeof asRecord(payload).producerId === "string" ? (asRecord(payload).producerId as string) : null
      if (!producerId) throw new Error("producerId kerak")
      await mediasoupService.pauseProducer(meetingId, socket.id, producerId)
      ack({ success: true })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Xatolik" })
    }
  })

  // Klient o'z producer'ini yopadi (talaba: kamera ⇄ ekran almashinuvi yoki
  // o'qituvchi ko'rishni to'xtatganda)
  socket.on("mediasoup:closeProducer", (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const producerId = typeof asRecord(payload).producerId === "string" ? (asRecord(payload).producerId as string) : null
      if (!producerId) throw new Error("producerId kerak")
      const owner = mediasoupService.getProducerSummary(meetingId, producerId)
      if (owner && owner.socketId === socket.id) {
        mediasoupService.closeProducer(meetingId, socket.id, producerId)
        const studentCamera = user.role === "student" && owner.source === "camera"
        io.to(studentCamera ? managersRoom : room).except(socket.id).emit("mediasoup:producerClosed", { producerId, socketId: socket.id })
      }
      ack({ success: true })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Xatolik" })
    }
  })

  socket.on("mediasoup:resumeProducer", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const producerId = typeof asRecord(payload).producerId === "string" ? (asRecord(payload).producerId as string) : null
      if (!producerId) throw new Error("producerId kerak")
      if (user.role === "student" && !socket.data.liveCamera) {
        const owner = mediasoupService.getProducerSummary(meetingId, producerId)
        if (owner?.source === "camera") throw new Error("Talaba kamerasi faqat o'qituvchi ko'rayotganda yuboriladi")
      }
      await mediasoupService.resumeProducer(meetingId, socket.id, producerId)
      ack({ success: true })
    } catch (issue) {
      ack({ success: false, error: issue instanceof Error ? issue.message : "Xatolik" })
    }
  })

  socket.on("media:state", (payload: unknown) => {
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {}
    const mediaState = {
      cameraEnabled: Boolean(record.cameraEnabled),
      micEnabled: Boolean(record.micEnabled),
      screenSharing: Boolean(record.screenSharing),
    }

    socket.data.mediaState = mediaState
    socket.to(room).emit("media:state", {
      socketId: socket.id,
      userId: user.id,
      fullName: user.fullName,
      role: user.role,
      groupId: user.groupId,
      ...mediaState,
    })
  })

  socket.on("meeting:watch", (payload: unknown) => {
    if (!isManager) return
    const raw = Array.isArray(asRecord(payload).userIds) ? (asRecord(payload).userIds as unknown[]) : []
    const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, MAX_WATCH_PER_MANAGER)
    let byMeeting = watchersByMeeting.get(meetingId)
    if (!byMeeting) { byMeeting = new Map(); watchersByMeeting.set(meetingId, byMeeting) }
    byMeeting.set(socket.id, ids)
    syncLiveCameras(meetingId)
  })

  socket.on("participant:snapshot", (payload: unknown) => {
    if (user.role !== "student") return
    const image = typeof asRecord(payload).image === "string" ? (asRecord(payload).image as string) : ""
    if (!image.startsWith("data:image/jpeg;base64,") || image.length > SNAPSHOT_MAX_CHARS) return
    const now = Date.now()
    if (now - (Number(socket.data.lastSnapshotAt) || 0) < SNAPSHOT_MIN_INTERVAL_MS) return
    socket.data.lastSnapshotAt = now
    const snapshot: ParticipantSnapshot = {
      socketId: socket.id, userId: user.id, fullName: user.fullName, groupId: user.groupId, image, at: now,
    }
    let byMeeting = snapshotsByMeeting.get(meetingId)
    if (!byMeeting) { byMeeting = new Map(); snapshotsByMeeting.set(meetingId, byMeeting) }
    byMeeting.set(socket.id, snapshot)
    io.to(managersRoom).emit("participant:snapshot", snapshot)
  })

  const cleanupMediasoupPeer = () => {
    dropSnapshot(meetingId, socket.id)
    if (dropWatcher(meetingId, socket.id)) syncLiveCameras(meetingId)
    const closedProducerIds = mediasoupService.cleanupPeer(meetingId, socket.id)
    closedProducerIds.forEach((producerId) => {
      socket.to(room).emit("mediasoup:producerClosed", { producerId, socketId: socket.id })
    })
  }

  // O'qituvchi (darsni boshqaruvchi) — boshqa barcha ishtirokchilarning
  // mikrofonini o'chiradi; ular keyin o'zlari qayta yoqishi mumkin.
  socket.on("meeting:muteAll", () => {
    if (!toMeetingResponse(meeting, user).permissions.canManageMeeting) return
    socket.to(room).emit("meeting:forceMute", { by: user.fullName })
  })

  socket.on("meeting:leave", async () => {
    // Boshqa ulanish bilan almashtirilgan — foydalanuvchi darsda qolmoqda
    if (socket.data.replaced) return
    await leaveMeeting(meetingId, user.id)
    cleanupMediasoupPeer()
    socket.to(room).emit("participant:left", {
      socketId: socket.id,
      userId: user.id,
      fullName: user.fullName,
      role: user.role,
      groupId: user.groupId,
      status: "left",
    })
    await emitParticipants()
    socket.leave(room)
    socket.disconnect(true)
  })

  socket.on("disconnect", async () => {
    if (socket.data.replaced) return
    await leaveMeeting(meetingId, user.id)
    cleanupMediasoupPeer()
    socket.to(room).emit("participant:left", {
      socketId: socket.id,
      userId: user.id,
      fullName: user.fullName,
      role: user.role,
      groupId: user.groupId,
      status: "left",
    })
    await emitParticipants()
  })
})

app.use((_req, res) => {
  res.status(404).json({ success: false, message: "Endpoint topilmadi" })
})

async function start() {
  try {
    await initDatabase()
    console.log("✓ MySQL tayyor")
    // Dars va topshiriq muddati eslatmalari (har daqiqada)
    startNotificationScheduler()
    // Tashakkurnoma: shartga yetgan o'qituvchilarga orqa fonda beriladi (har 10 daqiqada)
    startCertificateSweep()
    // Yuklangan videolarni telefonlarda ochiladigan MP4 ga keltirish (ffmpeg, fonda)
    startVideoTranscoder()

    // HEMIS to'liq talaba/xodim/guruh ro'yxati — login blokidan mustaqil
    // admin-token orqali fon rejimida sinxronlanadi (services/hemisSync.ts).
    // Serverni ishga tushirishni kutdirmasin deb fire-and-forget qilinadi,
    // so'ng belgilangan interval bilan takrorlanadi.
    void runFullHemisSync()
    const syncIntervalMs = Number(process.env.HEMIS_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000)
    setInterval(() => void runFullHemisSync(), syncIntervalMs)
  } catch (err) {
    console.error("✗ MySQL ulanmadi:", err instanceof Error ? err.message : err)
    console.log("  → OSPanel ni oching va MySQL 8.0 ni yoqing")
  }

  try {
    await mediasoupService.initMediasoupWorkers()
  } catch (err) {
    console.error("✗ mediasoup workerlarni ishga tushirishda xatolik:", err instanceof Error ? err.message : err)
  }

  httpServer.listen(PORT, () => {
    console.log(`\nLMS Backend - http://localhost:${PORT}`)
    console.log("API endpoints:")
    console.log("    GET    /health")
    console.log("    GET    /api/health")
    console.log("    POST   /api/auth/login")
    console.log("    GET    /api/meetings/my")
    console.log("    POST   /api/meetings/:id/join-token")
    console.log("    GET    /api/meetings/:id/attendance")
    console.log("    POST   /api/internal/attendance/sync")
  })
}

void start()
