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

export interface TelegramChatInfo {
  id: string
  title: string
  type: string
}

type TgChat = { id?: number; title?: string; first_name?: string; last_name?: string; username?: string; type?: string }

/**
 * Bot qo'shilgan chatlarni getUpdates orqali topish — admin guruh ID'sini
 * qo'lda qidirmasin. Telegram yangilanishlarni ~24 soat saqlaydi, shuning uchun
 * bot ancha oldin qo'shilgan bo'lsa guruhda «/start@bot» yozish kerak bo'ladi.
 */
export async function findTelegramChats(botToken: string): Promise<{ ok: boolean; message?: string; botUsername?: string; chats: TelegramChatInfo[] }> {
  try {
    const call = async (method: string) => {
      const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, { signal: AbortSignal.timeout(15000) })
      return await resp.json() as { ok: boolean; description?: string; result?: unknown }
    }
    const me = await call("getMe")
    if (!me.ok) return { ok: false, message: `Telegram xatosi: ${me.description ?? "noma'lum"}`, chats: [] }
    const updates = await call("getUpdates")
    if (!updates.ok) return { ok: false, message: `Telegram xatosi: ${updates.description ?? "noma'lum"}`, chats: [] }

    const chats = new Map<string, TelegramChatInfo>()
    const removed = new Set<string>()
    const add = (chat?: TgChat) => {
      if (!chat || chat.id === undefined) return
      const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || (chat.username ? `@${chat.username}` : "")
      chats.set(String(chat.id), { id: String(chat.id), title: name || String(chat.id), type: chat.type ?? "" })
    }
    for (const u of (updates.result as Record<string, Record<string, unknown>>[] | undefined) ?? []) {
      for (const key of ["message", "edited_message", "channel_post", "my_chat_member", "chat_member"]) {
        const part = u[key]
        if (!part) continue
        const chat = part.chat as TgChat | undefined
        add(chat)
        // Bot guruhdan chiqarilgan bo'lsa — ro'yxatda ko'rsatmaymiz
        const status = (part.new_chat_member as { status?: string } | undefined)?.status
        if (key === "my_chat_member" && chat?.id !== undefined) {
          if (status === "left" || status === "kicked") removed.add(String(chat.id))
          else removed.delete(String(chat.id))
        }
        // Oddiy guruh supergroup'ga aylansa ID o'zgaradi (-100...)
        const migrated = part.migrate_to_chat_id
        if (typeof migrated === "number" && chat) {
          removed.add(String(chat.id))
          add({ ...chat, id: migrated, type: "supergroup" })
        }
      }
    }
    const order: Record<string, number> = { supergroup: 0, group: 0, channel: 1, private: 2 }
    const list = [...chats.values()]
      .filter((c) => !removed.has(c.id))
      .sort((a, b) => (order[a.type] ?? 3) - (order[b.type] ?? 3) || a.title.localeCompare(b.title))
    const username = (me.result as { username?: string } | undefined)?.username
    return { ok: true, botUsername: username, chats: list }
  } catch (e) {
    return { ok: false, message: `Telegramga ulanib bo'lmadi: ${e instanceof Error ? e.message : "noma'lum"}`, chats: [] }
  }
}

export function escapeTelegramHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Avtomatik xabarlar navbati: bir guruhga daqiqasiga ~20 xabar chegarasi bor,
// bir vaqtda ko'p tashakkurnoma berilsa ham hammasi yetib borishi uchun ketma-ket
let queue: Promise<void> = Promise.resolve()

/** Sozlangan chatga HTML xabar (fon rejimida). Sozlanmagan bo'lsa — jim o'tib ketadi */
export function queueTelegramMessage(html: string): Promise<void> {
  queue = queue.then(() => sendQueued(html)).catch((err) => {
    console.warn("[telegram] xabar yuborilmadi:", err instanceof Error ? err.message : err)
  })
  return queue
}

async function sendQueued(html: string) {
  const { botToken, chatId } = await getTelegramConfig()
  if (!botToken || !chatId) return
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    })
    const json = await resp.json() as { ok: boolean; description?: string; parameters?: { retry_after?: number } }
    if (json.ok) break
    const retryAfter = json.parameters?.retry_after
    if (resp.status === 429 && retryAfter && attempt === 0) {
      await sleep(retryAfter * 1000 + 500)
      continue
    }
    console.warn("[telegram] xabar yuborilmadi:", json.description ?? resp.status)
    break
  }
  await sleep(3500)
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
