import * as mediasoup from "mediasoup"
import os from "os"

const mediaCodecs: mediasoup.types.RouterRtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000, parameters: { "x-google-start-bitrate": 1000 } },
]

const RTC_MIN_PORT = Number(process.env.MEDIASOUP_RTC_MIN_PORT || 40000)
const RTC_MAX_PORT = Number(process.env.MEDIASOUP_RTC_MAX_PORT || 40999)
const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0"
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || null

const ROUTER_TEARDOWN_DELAY_MS = 30_000

let workers: mediasoup.types.Worker[] = []
let nextWorkerIdx = 0

export async function initMediasoupWorkers(): Promise<void> {
  const numWorkers = Number(process.env.MEDIASOUP_NUM_WORKERS) || Math.max(1, os.cpus().length - 1)
  for (let i = 0; i < numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      logLevel: "warn",
      rtcMinPort: RTC_MIN_PORT,
      rtcMaxPort: RTC_MAX_PORT,
    })
    worker.on("died", () => {
      console.error(`[FATAL] mediasoup worker ${worker.pid} died — exiting so PM2 restarts cleanly`)
      process.exit(1)
    })
    workers.push(worker)
  }
  console.log(`✓ mediasoup: ${workers.length} worker(s) ready (rtc ports ${RTC_MIN_PORT}-${RTC_MAX_PORT}, announcedIp=${ANNOUNCED_IP ?? "NOT SET"})`)
}

export type ProducerSource = "camera" | "mic" | "screen"

export interface ProducerSummary {
  producerId: string
  socketId: string
  userId: number
  fullName: string
  role: string
  groupId: number | null
  kind: "audio" | "video"
  source: ProducerSource
}

interface PeerIdentity {
  socketId: string
  userId: number
  fullName: string
  role: string
  groupId: number | null
}

interface PeerMediaState extends PeerIdentity {
  transports: Map<string, mediasoup.types.WebRtcTransport>
  producers: Map<string, mediasoup.types.Producer>
  consumers: Map<string, mediasoup.types.Consumer>
}

interface MeetingMediaState {
  router: mediasoup.types.Router
  peers: Map<string, PeerMediaState>
  closeTimer: ReturnType<typeof setTimeout> | null
}

const meetings = new Map<number, MeetingMediaState>()
const creating = new Map<number, Promise<MeetingMediaState>>()

async function getOrCreateMeetingRouter(meetingId: number): Promise<MeetingMediaState> {
  const existing = meetings.get(meetingId)
  if (existing) {
    if (existing.closeTimer) {
      clearTimeout(existing.closeTimer)
      existing.closeTimer = null
    }
    return existing
  }

  const inFlight = creating.get(meetingId)
  if (inFlight) return inFlight

  const promise = (async () => {
    if (!workers.length) throw new Error("mediasoup workers hali tayyor emas")
    const worker = workers[nextWorkerIdx]
    nextWorkerIdx = (nextWorkerIdx + 1) % workers.length
    const router = await worker.createRouter({ mediaCodecs })
    const state: MeetingMediaState = { router, peers: new Map(), closeTimer: null }
    meetings.set(meetingId, state)
    creating.delete(meetingId)
    return state
  })()
  creating.set(meetingId, promise)
  return promise
}

export async function getRouterRtpCapabilities(meetingId: number): Promise<mediasoup.types.RtpCapabilities> {
  const state = await getOrCreateMeetingRouter(meetingId)
  return state.router.rtpCapabilities
}

export async function registerPeer(meetingId: number, peer: PeerIdentity): Promise<void> {
  const state = await getOrCreateMeetingRouter(meetingId)
  state.peers.set(peer.socketId, {
    ...peer,
    transports: new Map(),
    producers: new Map(),
    consumers: new Map(),
  })
}

function requirePeer(meetingId: number, socketId: string): { state: MeetingMediaState; peer: PeerMediaState } {
  const state = meetings.get(meetingId)
  const peer = state?.peers.get(socketId)
  if (!state || !peer) throw new Error("Meeting/peer topilmadi")
  return { state, peer }
}

export function listExistingProducers(meetingId: number, excludeSocketId?: string): ProducerSummary[] {
  const state = meetings.get(meetingId)
  if (!state) return []
  const result: ProducerSummary[] = []
  state.peers.forEach((peer) => {
    if (peer.socketId === excludeSocketId) return
    peer.producers.forEach((producer, producerId) => {
      result.push({
        producerId,
        socketId: peer.socketId,
        userId: peer.userId,
        fullName: peer.fullName,
        role: peer.role,
        groupId: peer.groupId,
        kind: producer.kind,
        source: (producer.appData.source as ProducerSource) ?? "camera",
      })
    })
  })
  return result
}

export async function createWebRtcTransport(meetingId: number, socketId: string) {
  const { state, peer } = requirePeer(meetingId, socketId)
  if (!ANNOUNCED_IP) throw new Error("MEDIASOUP_ANNOUNCED_IP sozlanmagan — .env ga qo'shing")

  const transport = await state.router.createWebRtcTransport({
    listenIps: [{ ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: false,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 800_000,
  })
  peer.transports.set(transport.id, transport)

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  }
}

export async function connectTransport(
  meetingId: number,
  socketId: string,
  transportId: string,
  dtlsParameters: mediasoup.types.DtlsParameters
): Promise<void> {
  const { peer } = requirePeer(meetingId, socketId)
  const transport = peer.transports.get(transportId)
  if (!transport) throw new Error("Transport topilmadi")
  await transport.connect({ dtlsParameters })
}

export async function produce(
  meetingId: number,
  socketId: string,
  params: { transportId: string; kind: mediasoup.types.MediaKind; rtpParameters: mediasoup.types.RtpParameters; source: ProducerSource }
): Promise<string> {
  const { peer } = requirePeer(meetingId, socketId)
  const transport = peer.transports.get(params.transportId)
  if (!transport) throw new Error("Transport topilmadi")

  const producer = await transport.produce({
    kind: params.kind,
    rtpParameters: params.rtpParameters,
    appData: { source: params.source },
  })
  peer.producers.set(producer.id, producer)
  return producer.id
}

export async function consume(
  meetingId: number,
  socketId: string,
  params: { transportId: string; producerId: string; rtpCapabilities: mediasoup.types.RtpCapabilities }
) {
  const { state, peer } = requirePeer(meetingId, socketId)
  const transport = peer.transports.get(params.transportId)
  if (!transport) throw new Error("Transport topilmadi")
  if (!state.router.canConsume({ producerId: params.producerId, rtpCapabilities: params.rtpCapabilities })) {
    throw new Error("Bu producer'ni consume qilib bo'lmaydi")
  }

  const consumer = await transport.consume({
    producerId: params.producerId,
    rtpCapabilities: params.rtpCapabilities,
    paused: true,
  })
  peer.consumers.set(consumer.id, consumer)

  return {
    id: consumer.id,
    producerId: params.producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
  }
}

export async function resumeConsumer(meetingId: number, socketId: string, consumerId: string): Promise<void> {
  const { peer } = requirePeer(meetingId, socketId)
  const consumer = peer.consumers.get(consumerId)
  if (!consumer) throw new Error("Consumer topilmadi")
  await consumer.resume()
}

export async function pauseProducer(meetingId: number, socketId: string, producerId: string): Promise<void> {
  const { peer } = requirePeer(meetingId, socketId)
  const producer = peer.producers.get(producerId)
  if (!producer) throw new Error("Producer topilmadi")
  await producer.pause()
}

export async function resumeProducer(meetingId: number, socketId: string, producerId: string): Promise<void> {
  const { peer } = requirePeer(meetingId, socketId)
  const producer = peer.producers.get(producerId)
  if (!producer) throw new Error("Producer topilmadi")
  await producer.resume()
}

export function closeProducer(meetingId: number, socketId: string, producerId: string): void {
  const { peer } = requirePeer(meetingId, socketId)
  const producer = peer.producers.get(producerId)
  if (!producer) return
  producer.close()
  peer.producers.delete(producerId)
}

function scheduleRouterTeardown(meetingId: number): void {
  const state = meetings.get(meetingId)
  if (!state || state.peers.size > 0) return
  state.closeTimer = setTimeout(() => {
    const s = meetings.get(meetingId)
    if (s && s.peers.size === 0) {
      s.router.close()
      meetings.delete(meetingId)
    }
  }, ROUTER_TEARDOWN_DELAY_MS)
}

export function cleanupPeer(meetingId: number, socketId: string): string[] {
  const state = meetings.get(meetingId)
  const peer = state?.peers.get(socketId)
  if (!state || !peer) return []

  const closedProducerIds = Array.from(peer.producers.keys())
  peer.transports.forEach((transport) => transport.close())
  state.peers.delete(socketId)

  if (state.peers.size === 0) scheduleRouterTeardown(meetingId)
  return closedProducerIds
}

export function closeMeetingRouter(meetingId: number): void {
  const state = meetings.get(meetingId)
  if (!state) return
  if (state.closeTimer) clearTimeout(state.closeTimer)
  state.router.close()
  meetings.delete(meetingId)
}
