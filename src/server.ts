import "dotenv/config"
import http from "http"
import express from "express"
import cors from "cors"
import { Server as SocketIOServer } from "socket.io"

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
  joinMeeting,
  leaveMeeting,
  toMeetingResponse,
  verifyJoinToken,
  type MeetingUser,
} from "./services/meetingStore"
import { publicResourcePath } from "./services/localResourceStore"
import { initDatabase } from "./services/db"

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

  const relaySignal = (event: "webrtc:offer" | "webrtc:answer" | "webrtc:ice-candidate") => {
    return (payload: unknown) => {
      const record =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {}
      const targetSocketId =
        typeof record.targetSocketId === "string"
          ? record.targetSocketId
          : typeof record.to === "string"
            ? record.to
            : null

      if (!targetSocketId) return
      const roomSockets = io.sockets.adapter.rooms.get(room)
      if (!roomSockets?.has(targetSocketId)) return

      io.to(targetSocketId).emit(event, {
        ...record,
        from: socket.id,
        fromUserId: user.id,
        user: {
          userId: user.id,
          fullName: user.fullName,
          role: user.role,
          groupId: user.groupId,
        },
      })
    }
  }

  socket.on("webrtc:offer", relaySignal("webrtc:offer"))
  socket.on("webrtc:answer", relaySignal("webrtc:answer"))
  socket.on("webrtc:ice-candidate", relaySignal("webrtc:ice-candidate"))

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

  socket.on("meeting:leave", async () => {
    await leaveMeeting(meetingId, user.id)
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
