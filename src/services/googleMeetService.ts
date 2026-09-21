import crypto from "crypto"
import axios, { AxiosError } from "axios"
import jwt from "jsonwebtoken"
import type mysql from "mysql2/promise"
import { pool } from "./db"

/* ── Sozlamalar ────────────────────────────────────────────────────────
   Google OAuth 2.0 (Web application client) — HAR BIR o'qituvchi o'z
   shaxsiy Google akkauntini ulaydi (Zoom integratsiyasi bilan bir xil
   naqsh — bitta umumiy hisob emas). Google Cloud Console'da yaratiladi
   (https://console.cloud.google.com). Kerakli environment variable'lar:
     GOOGLE_CLIENT_ID
     GOOGLE_CLIENT_SECRET
     GOOGLE_REDIRECT_URI        — masalan https://lms.sies.uz/api/integrations/google/callback
                                  (Google Cloud Console'dagi "Authorized redirect URI" bilan
                                  AYNAN bir xil bo'lishi shart)
     GOOGLE_STATE_SECRET        — OAuth "state" parametrini imzolash uchun (bo'lmasa JWT_SECRET ishlatiladi)
     GOOGLE_TOKEN_ENCRYPTION_KEY — 32 baytlik kalit, base64 shaklida
                                  (masalan: `openssl rand -base64 32` bilan yaratiladi;
                                  Zoom'nikidan ALOHIDA bo'lishi kerak)
   Google'ning oddiy (PKCE'siz) confidential-client authorization-code
   oqimi ishlatiladi — Zoom'dagidan farqli, chunki Google Web application
   turidagi client uchun PKCE majburiy emas (client_secret serverda
   maxfiy saqlanadi). ── */
const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token"
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo"
const GOOGLE_MEET_API_BASE = "https://meet.googleapis.com/v2"

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ""
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ""
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || ""
const GOOGLE_STATE_SECRET = process.env.GOOGLE_STATE_SECRET || process.env.JWT_SECRET || "secret"
const GOOGLE_MEET_SCOPES = (process.env.GOOGLE_MEET_SCOPES || "https://www.googleapis.com/auth/meetings.space.created")
const GOOGLE_SCOPES = [GOOGLE_MEET_SCOPES, "openid", "email"].join(" ")
const GOOGLE_TIMEOUT_MS = 15000

export function isGoogleMeetConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI)
}

/* ── Tokenlarni shifrlash (AES-256-GCM) — Zoom'dagi bilan bir xil usul,
   lekin alohida kalit bilan (bazada ochiq matnda saqlanmasin) ── */
const ENCRYPTION_KEY: Buffer = (() => {
  const raw = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || ""
  try {
    const buf = Buffer.from(raw, "base64")
    if (buf.length === 32) return buf
  } catch { /* quyida fallback ishlatiladi */ }
  console.warn("[google-meet] GOOGLE_TOKEN_ENCRYPTION_KEY to'g'ri sozlanmagan (32 bayt, base64) — vaqtinchalik zaif kalit ishlatilmoqda")
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
   ulanayotganini bilish uchun (Zoom bilan bir xil naqsh: brauzer Google'ga
   o'tib qaytganda hech qanday Authorization header/cookie kelmaydi). ── */
interface GoogleOAuthState {
  teacherId: number
  nonce: string
}

export function buildAuthorizationUrl(teacherId: number): string {
  const nonce = crypto.randomBytes(16).toString("hex")
  const state = jwt.sign({ teacherId, nonce } satisfies GoogleOAuthState, GOOGLE_STATE_SECRET, { expiresIn: "10m" })
  const params = new URLSearchParams({
    response_type: "code",
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    state,
    scope: GOOGLE_SCOPES,
    access_type: "offline", // refresh_token olish uchun shart
    prompt: "consent",      // har safar refresh_token qaytarilishini ta'minlaydi
    include_granted_scopes: "true",
  })
  return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

export function verifyState(state: string): GoogleOAuthState | null {
  try {
    return jwt.verify(state, GOOGLE_STATE_SECRET) as GoogleOAuthState
  } catch {
    return null
  }
}

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type?: string
}

function googleApiErrorMessage(err: unknown): string {
  const e = err as AxiosError<{ error?: string; error_description?: string; message?: string }>
  const detail = e?.response?.data?.error_description || e?.response?.data?.error || e?.response?.data?.message
  return detail || (err instanceof Error ? err.message : "Google bilan bog'lanishda xatolik")
}

async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: GOOGLE_REDIRECT_URI,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
  })
  const { data } = await axios.post<GoogleTokenResponse>(GOOGLE_OAUTH_TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: GOOGLE_TIMEOUT_MS,
  })
  return data
}

async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
  })
  const { data } = await axios.post<GoogleTokenResponse>(GOOGLE_OAUTH_TOKEN_URL, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: GOOGLE_TIMEOUT_MS,
  })
  return data
}

interface GoogleUserInfo {
  id: string
  email: string
}

async function fetchGoogleUser(accessToken: string): Promise<GoogleUserInfo> {
  const { data } = await axios.get<GoogleUserInfo>(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: GOOGLE_TIMEOUT_MS,
  })
  return data
}

/* ── google_meet_connections CRUD ──────────────────────────────────── */
export interface GoogleMeetConnectionRow extends mysql.RowDataPacket {
  id: number
  teacher_id: number
  google_user_id: string
  google_email: string | null
  access_token_encrypted: string
  refresh_token_encrypted: string
  token_expires_at: string
  scope: string | null
  status: "active" | "revoked" | "expired"
}

export interface GoogleMeetConnectionStatus {
  connected: boolean
  email: string | null
  status: "active" | "needs_reconnect" | "not_connected"
}

async function getConnectionRow(teacherId: number): Promise<GoogleMeetConnectionRow | null> {
  const [rows] = await pool.query<GoogleMeetConnectionRow[]>(
    "SELECT * FROM google_meet_connections WHERE teacher_id = ? LIMIT 1",
    [teacherId]
  )
  return rows[0] ?? null
}

export async function getConnectionStatus(teacherId: number): Promise<GoogleMeetConnectionStatus> {
  const row = await getConnectionRow(teacherId)
  if (!row || row.status === "revoked") return { connected: false, email: null, status: "not_connected" }
  if (row.status === "expired") return { connected: false, email: row.google_email, status: "needs_reconnect" }
  return { connected: true, email: row.google_email, status: "active" }
}

/** Ushbu teacher uchun ishlatsa bo'ladigan (kerak bo'lsa avtomatik yangilangan)
 *  access tokenni qaytaradi — Google API so'rovi ANIQ shu o'qituvchining
 *  ulangan hisobi nomidan bajarilishini ta'minlaydigan yagona kirish nuqtasi. */
export async function getValidAccessToken(teacherId: number): Promise<string | null> {
  const row = await getConnectionRow(teacherId)
  if (!row || row.status === "revoked") return null

  const expiresAt = new Date(row.token_expires_at).getTime()
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 2 * 60 * 1000) {
    return decrypt(row.access_token_encrypted)
  }

  try {
    const refreshToken = decrypt(row.refresh_token_encrypted)
    const tokens = await refreshAccessToken(refreshToken)
    await persistTokens(
      teacherId,
      { ...tokens, refresh_token: tokens.refresh_token || refreshToken }, // Google refresh javobida refresh_token qaytarmasligi mumkin — eskisi saqlanadi
      { googleUserId: row.google_user_id, googleEmail: row.google_email }
    )
    return tokens.access_token
  } catch (err) {
    console.warn(`[google-meet] teacher ${teacherId} uchun token yangilashda xato:`, googleApiErrorMessage(err))
    await pool.query("UPDATE google_meet_connections SET status = 'expired' WHERE teacher_id = ?", [teacherId])
    return null
  }
}

async function persistTokens(
  teacherId: number,
  tokens: GoogleTokenResponse,
  googleUser: { googleUserId: string; googleEmail: string | null }
): Promise<void> {
  if (!tokens.refresh_token) {
    throw new Error("Google refresh_token qaytarmadi (access_type=offline/prompt=consent tekshiring)")
  }
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000)
  await pool.query(
    `INSERT INTO google_meet_connections
       (teacher_id, google_user_id, google_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, scope, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE
       google_user_id = VALUES(google_user_id), google_email = VALUES(google_email),
       access_token_encrypted = VALUES(access_token_encrypted), refresh_token_encrypted = VALUES(refresh_token_encrypted),
       token_expires_at = VALUES(token_expires_at), scope = VALUES(scope), status = 'active'`,
    [
      teacherId, googleUser.googleUserId, googleUser.googleEmail,
      encrypt(tokens.access_token), encrypt(tokens.refresh_token), expiresAtToMysql(expiresAt), tokens.scope ?? null,
    ]
  )
}

function expiresAtToMysql(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Google OAuth callback'da chaqiriladi — kod token'larga almashtiriladi,
 *  Google foydalanuvchi ma'lumoti olinadi va shu teacher bilan bog'lanadi. */
export async function completeAuthorization(teacherId: number, code: string): Promise<{ email: string }> {
  const tokens = await exchangeCodeForTokens(code)
  const googleUser = await fetchGoogleUser(tokens.access_token)
  await persistTokens(teacherId, tokens, { googleUserId: googleUser.id, googleEmail: googleUser.email })
  return { email: googleUser.email }
}

export async function disconnect(teacherId: number): Promise<void> {
  // Yozuv butunlay o'chirilmaydi — eski meeting'larning bog'lanishi
  // buzilmasligi uchun holat 'revoked'ga o'tkaziladi, xolos (Zoom bilan bir xil).
  await pool.query("UPDATE google_meet_connections SET status = 'revoked' WHERE teacher_id = ?", [teacherId])
}

/* ── Google Meet space (meeting) yaratish ─────────────────────────── */
export interface CreateGoogleMeetInput {
  topic: string
}

export interface CreateGoogleMeetResult {
  spaceName: string
  meetingUri: string
  meetingCode: string | null
}

export class GoogleMeetNotConnectedError extends Error {}
export class GoogleMeetApiError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export async function createGoogleMeetForTeacher(
  teacherId: number,
  _input: CreateGoogleMeetInput
): Promise<CreateGoogleMeetResult> {
  const accessToken = await getValidAccessToken(teacherId)
  if (!accessToken) throw new GoogleMeetNotConnectedError("Google account ulanmagan yoki qayta ulash kerak")

  try {
    // Google Meet REST API hozircha meeting sarlavhasi/vaqtini space
    // yaratishda qabul qilmaydi (topic/start/end parametri yo'q) — faqat
    // bir martalik "space" yaratiladi, LMS o'zining sarlavha/vaqtini
    // saqlaydi (lms_meetings jadvalida allaqachon bor).
    const { data } = await axios.post(
      `${GOOGLE_MEET_API_BASE}/spaces`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, timeout: GOOGLE_TIMEOUT_MS }
    )
    return {
      spaceName: String(data.name),
      meetingUri: String(data.meetingUri),
      meetingCode: data.meetingCode ? String(data.meetingCode) : null,
    }
  } catch (err) {
    const e = err as AxiosError<{ error?: { message?: string; status?: string } }>
    const status = e?.response?.status
    const code = status ? String(status) : (axios.isAxiosError(e) && e.code) || "unknown"
    const message = e?.response?.data?.error?.message || googleApiErrorMessage(err)
    throw new GoogleMeetApiError(message, code)
  }
}

/* ── lms_meeting_google_meet — bitta LMS meeting bilan bog'langan Google
   Meet yozuvi ── */
export interface MeetingGoogleMeetRow extends mysql.RowDataPacket {
  id: number
  meeting_id: number
  teacher_id: number
  google_space_name: string | null
  google_meeting_uri: string | null
  google_meeting_code: string | null
  status: "pending" | "created" | "failed"
  error_code: string | null
  error_message: string | null
}

export interface PublicGoogleMeetInfo {
  status: "pending" | "created" | "failed"
  meetingUri: string | null
  meetingCode: string | null
  errorMessage: string | null
}

export async function getMeetingGoogleMeetRow(meetingId: number): Promise<MeetingGoogleMeetRow | null> {
  const [rows] = await pool.query<MeetingGoogleMeetRow[]>(
    "SELECT * FROM lms_meeting_google_meet WHERE meeting_id = ? LIMIT 1",
    [meetingId]
  )
  return rows[0] ?? null
}

export function toPublicGoogleMeetInfo(row: MeetingGoogleMeetRow | null): PublicGoogleMeetInfo | null {
  if (!row) return null
  return {
    status: row.status,
    meetingUri: row.google_meeting_uri,
    meetingCode: row.google_meeting_code,
    errorMessage: row.status === "failed" ? row.error_message : null,
  }
}

/** LMS meeting yaratilgandan/qayta urinilgandan keyin chaqiriladi — Google
 *  Meet space yaratishga harakat qiladi va natijani (muvaffaqiyat yoki
 *  xato) `lms_meeting_google_meet`ga yozadi. Hech qachon istisno otmaydi —
 *  chaqiruvchi har doim {ok, info} oladi, LMS meetingning o'zi bunga
 *  bog'liq bo'lmaydi (Zoom bilan bir xil naqsh). */
export async function createAndSaveGoogleMeetMeeting(
  meetingId: number,
  teacherId: number,
  input: CreateGoogleMeetInput
): Promise<{ ok: boolean; info: PublicGoogleMeetInfo }> {
  try {
    const result = await createGoogleMeetForTeacher(teacherId, input)
    await pool.query(
      `INSERT INTO lms_meeting_google_meet
         (meeting_id, teacher_id, google_space_name, google_meeting_uri, google_meeting_code, status, error_code, error_message)
       VALUES (?, ?, ?, ?, ?, 'created', NULL, NULL)
       ON DUPLICATE KEY UPDATE
         google_space_name = VALUES(google_space_name), google_meeting_uri = VALUES(google_meeting_uri),
         google_meeting_code = VALUES(google_meeting_code), status = 'created', error_code = NULL, error_message = NULL`,
      [meetingId, teacherId, result.spaceName, result.meetingUri, result.meetingCode]
    )
    return {
      ok: true,
      info: { status: "created", meetingUri: result.meetingUri, meetingCode: result.meetingCode, errorMessage: null },
    }
  } catch (err) {
    const isNotConnected = err instanceof GoogleMeetNotConnectedError
    const code = err instanceof GoogleMeetApiError ? err.code : (isNotConnected ? "not_connected" : "unknown")
    const message = err instanceof Error ? err.message : "Google Meet yaratilmadi"
    await pool.query(
      `INSERT INTO lms_meeting_google_meet (meeting_id, teacher_id, status, error_code, error_message)
       VALUES (?, ?, 'failed', ?, ?)
       ON DUPLICATE KEY UPDATE status = 'failed', error_code = VALUES(error_code), error_message = VALUES(error_message)`,
      [meetingId, teacherId, code, message]
    )
    return { ok: false, info: { status: "failed", meetingUri: null, meetingCode: null, errorMessage: message } }
  }
}
