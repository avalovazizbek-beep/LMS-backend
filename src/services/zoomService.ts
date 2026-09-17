import crypto from "crypto"
import axios, { AxiosError } from "axios"
import jwt from "jsonwebtoken"
import type mysql from "mysql2/promise"
import { pool } from "./db"

/* ── Sozlamalar ────────────────────────────────────────────────────────
   Zoom OAuth App (General App, User-managed — HAR BIR o'qituvchi o'z
   Zoom hisobini ulaydi, bitta umumiy hisob emas) https://developers.zoom.us
   Marketplace'da yaratiladi. Kerakli environment variable'lar:
     ZOOM_CLIENT_ID          — OAuth App Client ID
     ZOOM_CLIENT_SECRET      — OAuth App Client Secret (faqat backend'da)
     ZOOM_REDIRECT_URI       — masalan https://api.sies.uz/api/integrations/zoom/callback
                               (Zoom App sozlamasidagi "Redirect URL for OAuth" bilan
                               AYNAN bir xil bo'lishi shart)
     ZOOM_STATE_SECRET       — OAuth "state" parametrini imzolash uchun (bo'lmasa JWT_SECRET ishlatiladi)
     ZOOM_TOKEN_ENCRYPTION_KEY — 32 baytlik kalit, base64 shaklida
                               (masalan: `openssl rand -base64 32` bilan yaratiladi)
     FRONTEND_URL, FRONTEND_BASE_PATH — callback tugagach foydalanuvchi
                               qaytariladigan sahifa (mavjud HEMIS OAuth bilan bir xil) ── */
const ZOOM_OAUTH_BASE = "https://zoom.us/oauth"
const ZOOM_API_BASE = "https://api.zoom.us/v2"
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || ""
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || ""
const ZOOM_REDIRECT_URI = process.env.ZOOM_REDIRECT_URI || ""
const ZOOM_STATE_SECRET = process.env.ZOOM_STATE_SECRET || process.env.JWT_SECRET || "secret"
const ZOOM_TIMEOUT_MS = 15000

export function isZoomConfigured(): boolean {
  return !!(ZOOM_CLIENT_ID && ZOOM_CLIENT_SECRET && ZOOM_REDIRECT_URI)
}

/* ── Tokenlarni shifrlash (AES-256-GCM) — bazada ochiq matnda saqlanmasin ── */
const ENCRYPTION_KEY: Buffer = (() => {
  const raw = process.env.ZOOM_TOKEN_ENCRYPTION_KEY || ""
  try {
    const buf = Buffer.from(raw, "base64")
    if (buf.length === 32) return buf
  } catch { /* quyida fallback ishlatiladi */ }
  // Ishlab chiqarishda ZOOM_TOKEN_ENCRYPTION_KEY albatta to'g'ri 32-baytli
  // base64 kalit sifatida berilishi kerak — bu faqat kalit hali sozlanmagan
  // holatda serverni ishga tushishdan to'xtatib qo'ymaslik uchun zaxira.
  console.warn("[zoom] ZOOM_TOKEN_ENCRYPTION_KEY to'g'ri sozlanmagan (32 bayt, base64) — vaqtinchalik zaif kalit ishlatilmoqda")
  return crypto.createHash("sha256").update(raw || "insecure-dev-key-change-me").digest()
})()

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString("base64")
}

function decrypt(payload: string): string {
  const raw = Buffer.from(payload, "base64")
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const enc = raw.subarray(28)
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
}

/* ── OAuth "state" — CSRF himoyasi + callback'da qaysi o'qituvchi
   ulanayotganini bilish uchun (brauzer Zoom'ga o'tib qaytganda hech qanday
   Authorization header/cookie kelmaydi, shu sabab bu ma'lumot state ichida
   imzolangan holda tashiladi — meeting join-token bilan bir xil naqsh). ── */
interface ZoomOAuthState {
  teacherId: number
  nonce: string
  codeVerifier: string
}

/** Zoom'ning yangi "General App" turi PKCE (RFC 7636) talab qiladi — bo'lmasa
 *  /oauth/authorize "Invalid client_id" deb (chalg'ituvchi, lekin aslida PKCE
 *  yo'qligi haqidagi) xato qaytaradi. code_verifier'ni serverda saqlamasdan,
 *  imzolangan `state` JWT ichiga solib yuboramiz — callback shu yerdan o'qib,
 *  token almashinuvida qaytaradi. */
function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url")
}

function codeChallengeFromVerifier(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url")
}

export function buildAuthorizationUrl(teacherId: number): string {
  const nonce = crypto.randomBytes(16).toString("hex")
  const codeVerifier = generateCodeVerifier()
  const state = jwt.sign({ teacherId, nonce, codeVerifier } satisfies ZoomOAuthState, ZOOM_STATE_SECRET, { expiresIn: "10m" })
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ZOOM_CLIENT_ID,
    redirect_uri: ZOOM_REDIRECT_URI,
    state,
    code_challenge: codeChallengeFromVerifier(codeVerifier),
    code_challenge_method: "S256",
  })
  return `${ZOOM_OAUTH_BASE}/authorize?${params.toString()}`
}

export function verifyState(state: string): ZoomOAuthState | null {
  try {
    return jwt.verify(state, ZOOM_STATE_SECRET) as ZoomOAuthState
  } catch {
    return null
  }
}

interface ZoomTokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
}

function basicAuthHeader() {
  return `Basic ${Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64")}`
}

function zoomOAuthErrorMessage(err: unknown): string {
  const e = err as AxiosError<{ error?: string; reason?: string; message?: string }>
  const detail = e?.response?.data?.reason || e?.response?.data?.error || e?.response?.data?.message
  return detail || (err instanceof Error ? err.message : "Zoom bilan bog'lanishda xatolik")
}

async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ZoomTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ZOOM_REDIRECT_URI,
    code_verifier: codeVerifier,
  })
  const { data } = await axios.post<ZoomTokenResponse>(`${ZOOM_OAUTH_BASE}/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    timeout: ZOOM_TIMEOUT_MS,
  })
  return data
}

async function refreshTokens(refreshToken: string): Promise<ZoomTokenResponse> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  const { data } = await axios.post<ZoomTokenResponse>(`${ZOOM_OAUTH_BASE}/token`, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuthHeader() },
    timeout: ZOOM_TIMEOUT_MS,
  })
  return data
}

interface ZoomUserInfo {
  id: string
  email: string
  account_id?: string
}

async function fetchZoomUser(accessToken: string): Promise<ZoomUserInfo> {
  const { data } = await axios.get<ZoomUserInfo>(`${ZOOM_API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: ZOOM_TIMEOUT_MS,
  })
  return data
}

/* ── zoom_connections CRUD ─────────────────────────────────────────── */
export interface ZoomConnectionRow extends mysql.RowDataPacket {
  id: number
  teacher_id: number
  zoom_user_id: string
  zoom_account_id: string | null
  zoom_email: string | null
  access_token_encrypted: string
  refresh_token_encrypted: string
  token_expires_at: string
  status: "active" | "revoked" | "expired"
}

export interface ZoomConnectionStatus {
  connected: boolean
  email: string | null
  status: "active" | "needs_reconnect" | "not_connected"
}

async function getConnectionRow(teacherId: number): Promise<ZoomConnectionRow | null> {
  const [rows] = await pool.query<ZoomConnectionRow[]>(
    "SELECT * FROM zoom_connections WHERE teacher_id = ? LIMIT 1",
    [teacherId]
  )
  return rows[0] ?? null
}

export async function getConnectionStatus(teacherId: number): Promise<ZoomConnectionStatus> {
  const row = await getConnectionRow(teacherId)
  if (!row || row.status === "revoked") return { connected: false, email: null, status: "not_connected" }
  if (row.status === "expired") return { connected: false, email: row.zoom_email, status: "needs_reconnect" }
  return { connected: true, email: row.zoom_email, status: "active" }
}

/** Ushbu teacher uchun ishlatsa bo'ladigan (kerak bo'lsa avtomatik yangilangan)
 *  access tokenni qaytaradi — Zoom API so'rovi ANIQ shu o'qituvchining
 *  ulangan hisobi nomidan bajarilishini ta'minlaydigan yagona kirish nuqtasi. */
export async function getValidAccessToken(teacherId: number): Promise<string | null> {
  const row = await getConnectionRow(teacherId)
  if (!row || row.status === "revoked") return null

  const expiresAt = new Date(row.token_expires_at).getTime()
  // 2 daqiqalik zaxira — so'rov Zoom'ga yetib borguncha token muddati
  // tugab qolishining oldini oladi.
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 2 * 60 * 1000) {
    return decrypt(row.access_token_encrypted)
  }

  try {
    const refreshToken = decrypt(row.refresh_token_encrypted)
    const tokens = await refreshTokens(refreshToken)
    await persistTokens(teacherId, tokens, { zoomUserId: row.zoom_user_id, zoomAccountId: row.zoom_account_id, zoomEmail: row.zoom_email })
    return tokens.access_token
  } catch (err) {
    console.warn(`[zoom] teacher ${teacherId} uchun token yangilashda xato:`, zoomOAuthErrorMessage(err))
    await pool.query("UPDATE zoom_connections SET status = 'expired' WHERE teacher_id = ?", [teacherId])
    return null
  }
}

async function persistTokens(
  teacherId: number,
  tokens: ZoomTokenResponse,
  zoomUser: { zoomUserId: string; zoomAccountId: string | null; zoomEmail: string | null }
): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  await pool.query(
    `INSERT INTO zoom_connections
       (teacher_id, zoom_user_id, zoom_account_id, zoom_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, scope, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       zoom_user_id = VALUES(zoom_user_id), zoom_account_id = VALUES(zoom_account_id), zoom_email = VALUES(zoom_email),
       access_token_encrypted = VALUES(access_token_encrypted), refresh_token_encrypted = VALUES(refresh_token_encrypted),
       token_expires_at = VALUES(token_expires_at), scope = VALUES(scope), status = 'active'`,
    [
      teacherId, zoomUser.zoomUserId, zoomUser.zoomAccountId, zoomUser.zoomEmail,
      encrypt(tokens.access_token), encrypt(tokens.refresh_token), expiresAtToMysql(expiresAt), tokens.scope ?? null,
    ]
  )
}

function expiresAtToMysql(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Zoom OAuth callback'da chaqiriladi — kod token'larga almashtiriladi,
 *  Zoom foydalanuvchi ma'lumoti olinadi va shu teacher bilan bog'lanadi. */
export async function completeAuthorization(teacherId: number, code: string, codeVerifier: string): Promise<{ email: string }> {
  const tokens = await exchangeCodeForTokens(code, codeVerifier)
  const zoomUser = await fetchZoomUser(tokens.access_token)
  await persistTokens(teacherId, tokens, { zoomUserId: zoomUser.id, zoomAccountId: zoomUser.account_id ?? null, zoomEmail: zoomUser.email })
  return { email: zoomUser.email }
}

export async function disconnect(teacherId: number): Promise<void> {
  // Yozuv butunlay o'chirilmaydi — eski meeting'larning zoom_connection_id
  // bog'lanishi (agar kerak bo'lib qolsa) buzilmasligi uchun holat
  // 'revoked'ga o'tkaziladi, xolos.
  await pool.query("UPDATE zoom_connections SET status = 'revoked' WHERE teacher_id = ?", [teacherId])
}

/* ── Zoom Meeting yaratish ─────────────────────────────────────────── */
export interface CreateZoomMeetingInput {
  topic: string
  agenda: string | null
  startTime: string // ISO yoki "YYYY-MM-DD HH:mm:ss" — Toshkent vaqti sifatida talqin qilinadi
  endTime: string
}

export interface CreateZoomMeetingResult {
  zoomMeetingId: string
  joinUrl: string
  startUrl: string
  password: string | null
}

/** LMS'dagi (server local vaqti = Asia/Tashkent deb qabul qilingan, butun
 *  meeting/davomat tizimi shu taxminga asoslangan) sana-vaqtni Zoom kutgan
 *  "join qiluvchi mahalliy vaqt + timezone" formatiga o'giradi. */
function toZoomLocalDateTime(value: string): string {
  const d = new Date(value)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export class ZoomNotConnectedError extends Error {}
export class ZoomApiError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export async function createZoomMeetingForTeacher(
  teacherId: number,
  input: CreateZoomMeetingInput
): Promise<CreateZoomMeetingResult> {
  const accessToken = await getValidAccessToken(teacherId)
  if (!accessToken) throw new ZoomNotConnectedError("Zoom account ulanmagan yoki qayta ulash kerak")

  const durationMinutes = Math.max(1, Math.round((new Date(input.endTime).getTime() - new Date(input.startTime).getTime()) / 60000))

  try {
    const { data } = await axios.post(
      `${ZOOM_API_BASE}/users/me/meetings`,
      {
        topic: input.topic.slice(0, 200),
        type: 2, // Scheduled meeting
        start_time: toZoomLocalDateTime(input.startTime),
        duration: durationMinutes,
        timezone: "Asia/Tashkent",
        agenda: (input.agenda || "").slice(0, 2000),
        settings: {
          join_before_host: true,
          waiting_room: false,
          approval_type: 2, // No registration required
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: ZOOM_TIMEOUT_MS }
    )
    return {
      zoomMeetingId: String(data.id),
      joinUrl: data.join_url,
      startUrl: data.start_url,
      password: data.password || null,
    }
  } catch (err) {
    const e = err as AxiosError<{ code?: number; message?: string }>
    const status = e?.response?.status
    const code = status ? String(status) : (axios.isAxiosError(e) && e.code) || "unknown"
    throw new ZoomApiError(zoomOAuthErrorMessage(err), code)
  }
}

/* ── lms_meeting_zoom — bitta LMS meeting bilan bog'langan Zoom yozuvi ── */
export interface MeetingZoomRow extends mysql.RowDataPacket {
  id: number
  meeting_id: number
  teacher_id: number
  zoom_meeting_id: string | null
  zoom_join_url: string | null
  zoom_start_url_encrypted: string | null
  zoom_password: string | null
  status: "pending" | "created" | "failed"
  error_code: string | null
  error_message: string | null
}

export interface PublicZoomInfo {
  status: "pending" | "created" | "failed"
  meetingId: string | null
  joinUrl: string | null
  startUrl: string | null
  password: string | null
  errorMessage: string | null
}

export async function getMeetingZoomRow(meetingId: number): Promise<MeetingZoomRow | null> {
  const [rows] = await pool.query<MeetingZoomRow[]>(
    "SELECT * FROM lms_meeting_zoom WHERE meeting_id = ? LIMIT 1",
    [meetingId]
  )
  return rows[0] ?? null
}

/** Talaba uchun ham, o'qituvchi/admin uchun ham xavfsiz shaklda qaytariladi —
 *  `start_url` (Zoom hostlik tokenini o'z ichiga oladi) faqat `canManage`
 *  true bo'lgandagina qo'shiladi, aks holda hech qachon frontendga chiqmaydi. */
export function toPublicZoomInfo(row: MeetingZoomRow | null, canManage: boolean): PublicZoomInfo | null {
  if (!row) return null
  return {
    status: row.status,
    meetingId: row.zoom_meeting_id,
    joinUrl: row.zoom_join_url,
    startUrl: canManage && row.zoom_start_url_encrypted ? decrypt(row.zoom_start_url_encrypted) : null,
    password: row.zoom_password,
    errorMessage: row.status === "failed" ? row.error_message : null,
  }
}

/** LMS meeting yaratilgandan/qayta urinilgandan keyin chaqiriladi — Zoom
 *  meeting yaratishga harakat qiladi va natijani (muvaffaqiyat yoki xato)
 *  `lms_meeting_zoom`ga yozadi. Hech qachon istisno otmaydi — chaqiruvchi
 *  har doim {ok, info} oladi, LMS meetingning o'zi bunga bog'liq bo'lmaydi. */
export async function createAndSaveZoomMeeting(
  meetingId: number,
  teacherId: number,
  input: CreateZoomMeetingInput
): Promise<{ ok: boolean; info: PublicZoomInfo }> {
  try {
    const result = await createZoomMeetingForTeacher(teacherId, input)
    await pool.query(
      `INSERT INTO lms_meeting_zoom
         (meeting_id, teacher_id, zoom_meeting_id, zoom_join_url, zoom_start_url_encrypted, zoom_password, status, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, ?, 'created', NULL, NULL)
       ON DUPLICATE KEY UPDATE
         zoom_meeting_id = VALUES(zoom_meeting_id), zoom_join_url = VALUES(zoom_join_url),
         zoom_start_url_encrypted = VALUES(zoom_start_url_encrypted), zoom_password = VALUES(zoom_password),
         status = 'created', error_code = NULL, error_message = NULL`,
      [meetingId, teacherId, result.zoomMeetingId, result.joinUrl, encrypt(result.startUrl), result.password]
    )
    return {
      ok: true,
      info: { status: "created", meetingId: result.zoomMeetingId, joinUrl: result.joinUrl, startUrl: result.startUrl, password: result.password, errorMessage: null },
    }
  } catch (err) {
    const isNotConnected = err instanceof ZoomNotConnectedError
    const code = err instanceof ZoomApiError ? err.code : (isNotConnected ? "not_connected" : "unknown")
    const message = err instanceof Error ? err.message : "Zoom meeting yaratilmadi"
    await pool.query(
      `INSERT INTO lms_meeting_zoom (meeting_id, teacher_id, status, error_code, error_message)
       VALUES (?, ?, 'failed', ?, ?)
       ON DUPLICATE KEY UPDATE status = 'failed', error_code = VALUES(error_code), error_message = VALUES(error_message)`,
      [meetingId, teacherId, code, message]
    )
    return { ok: false, info: { status: "failed", meetingId: null, joinUrl: null, startUrl: null, password: null, errorMessage: message } }
  }
}
