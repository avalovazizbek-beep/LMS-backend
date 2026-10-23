import type { RowDataPacket } from "mysql2"
import { pool } from "./db"
import { encryptSecret, decryptSecret } from "./credentialCrypto"

/**
 * Telegram bot sozlamasi admin «Sozlamalar» sahifasidan kiritiladi (lms_settings).
 * U yerda kiritilmagan maydon uchun .env dagi TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 * ishlatiladi. Token bazada shifrlangan saqlanadi va brauzerga faqat yashirilgan
 * holda (123456:…abcd) qaytariladi.
 */
export const TELEGRAM_TOKEN_KEY = "telegram_bot_token"
export const TELEGRAM_CHAT_KEY = "telegram_chat_id"

export type TelegramSource = "settings" | "env" | "none"

export interface TelegramConfig {
  botToken: string
  chatId: string
  tokenSource: TelegramSource
  chatSource: TelegramSource
}

const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/
const CHAT_RE = /^(-?\d{3,}|@[A-Za-z0-9_]{5,})$/

export function isValidTelegramToken(value: string) {
  return TOKEN_RE.test(value)
}

export function isValidTelegramChatId(value: string) {
  return CHAT_RE.test(value)
}

export function maskTelegramToken(token: string) {
  if (!token) return ""
  const [botId] = token.split(":")
  return `${botId}:…${token.slice(-4)}`
}

export async function getTelegramConfig(): Promise<TelegramConfig> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT key_name, value FROM lms_settings WHERE key_name IN (?, ?)",
    [TELEGRAM_TOKEN_KEY, TELEGRAM_CHAT_KEY]
  )
  const saved = Object.fromEntries(rows.map((r) => [String(r.key_name), String(r.value ?? "")]))
  const savedToken = saved[TELEGRAM_TOKEN_KEY] ? decryptSecret(saved[TELEGRAM_TOKEN_KEY]) ?? "" : ""
  const savedChat = (saved[TELEGRAM_CHAT_KEY] ?? "").trim()
  const envToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim()
  const envChat = (process.env.TELEGRAM_CHAT_ID ?? "").trim()

  return {
    botToken: savedToken || envToken,
    chatId: savedChat || envChat,
    tokenSource: savedToken ? "settings" : envToken ? "env" : "none",
    chatSource: savedChat ? "settings" : envChat ? "env" : "none",
  }
}

export async function saveTelegramToken(token: string) {
  await pool.query(
    "INSERT INTO lms_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [TELEGRAM_TOKEN_KEY, encryptSecret(token)]
  )
}

/** Sinov xabari — token va chat to'g'riligini darhol tekshirish uchun */
export async function sendTelegramTestMessage(botToken: string, chatId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: "✅ SamISI LMS: Telegram bot ulandi. Hisobotlar va xabarlar shu chatga keladi." }),
      signal: AbortSignal.timeout(15000),
    })
    const json = await resp.json() as { ok: boolean; description?: string }
    return json.ok
      ? { ok: true, message: "Sinov xabari yuborildi — Telegram chatni tekshiring" }
      : { ok: false, message: `Telegram xatosi: ${json.description ?? "noma'lum"}` }
  } catch (e) {
    return { ok: false, message: `Telegramga ulanib bo'lmadi: ${e instanceof Error ? e.message : "noma'lum"}` }
  }
}
