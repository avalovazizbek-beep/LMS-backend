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
import {
  getAttendance,
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
import * as mediasoupService from "./services/mediasoupService"

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason)
})
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err)
})

const app = express()
const PORT = process.env.PORT || 5000
const FRONTEND_ORIGIN = process.env.FRONTEND_URL || "http://localhost:3000"
const ALLOWED_ORIGINS = [
  FRONTEND_ORIGIN,
  "http://localhost:3000",
  "http://localhost:3001",
]

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true)
    } else {
      callback(null, true)
    }
  },
  credentials: true,
}))
app.use(express.json({ limit: "25mb" }))
app.use(express.urlencoded({ extended: true }))
app.use("/uploads", express.static(publicResourcePath()))

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

  res.redirect(new URL(req.originalUrl, FRONTEND_ORIGIN).toString())
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

const httpServer = http.createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: { origin: FRONTEND_ORIGIN, credentials: true },
})
setSocketIO(io)

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

  const emitParticipants = async () => {
    io.to(room).emit("participants", await participantPayload(meetingId))
  }

  const joinedPayload = async () => {
    const response = toMeetingResponse(meeting, user)
    return {
      meetingId,
      user,
      meeting: response,
      permissions: response.permissions,
      participants: await participantPayload(meetingId),
      peers: socketPeerPayload(room, socket.id),
      messages: getChatMessages(meetingId),
      rtpCapabilities: await mediasoupService.getRouterRtpCapabilities(meetingId),
      producers: mediasoupService.listExistingProducers(meetingId, socket.id),
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
      socket.to(room).emit("mediasoup:newProducer", {
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

      const data = await mediasoupService.consume(meetingId, socket.id, {
        transportId,
        producerId,
        rtpCapabilities: record.rtpCapabilities as MediasoupTypes.RtpCapabilities,
      })
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

  socket.on("mediasoup:resumeProducer", async (payload: unknown, ack?: unknown) => {
    if (typeof ack !== "function") return
    try {
      const producerId = typeof asRecord(payload).producerId === "string" ? (asRecord(payload).producerId as string) : null
      if (!producerId) throw new Error("producerId kerak")
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

  const cleanupMediasoupPeer = () => {
    const closedProducerIds = mediasoupService.cleanupPeer(meetingId, socket.id)
    closedProducerIds.forEach((producerId) => {
      socket.to(room).emit("mediasoup:producerClosed", { producerId, socketId: socket.id })
    })
  }

  socket.on("meeting:leave", async () => {
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
