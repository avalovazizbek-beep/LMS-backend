import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { pool } from "./db"
import { teacherUserId, studentUserId } from "./teachingStore"
import type { AuthRequest } from "../middleware/auth"

/**
 * Bildirishnomalar (Xabarnomalar) — har biri aniq bir foydalanuvchiga
 * tegishli. Egasi faqat raqamli ID emas, ROL + ID: talaba va xodim
 * ID'lari turli HEMIS jadvallaridan keladi va bir xil raqam bo'lishi
 * mumkin (talaba 123 ≠ xodim 123), shuning uchun faqat ID bo'yicha
 * filtrlash birovning xabarini boshqasiga ko'rsatib yuborardi.
 */

export type NotificationType = "system" | "teacher" | "schedule" | "reminder" | "support"

export interface NotificationOwner {
  role: string
  userId: number
}

export interface CreateNotificationInput extends NotificationOwner {
  type: NotificationType
  /** O'zbekcha matn — i18nKey tarjimasi bo'lmagan joyda ko'rsatiladi */
  title: string
  body?: string | null
  /** Bosilganda o'tiladigan sahifa (masalan /murojaatlar?c=12) */
  link?: string | null
  /** Frontend lug'atidagi kalit: `notif.<key>.title` / `notif.<key>.body` */
  i18nKey?: string | null
  i18nParams?: Record<string, string | number> | null
}

/** So'rov egasini aniqlaydi: talaba — studentUserId, qolganlar — teacherUserId. */
export function notificationOwnerOf(req: AuthRequest): NotificationOwner {
  const role = req.user?.role === "student" ? "student" : String(req.user?.role || "employee")
  const userId = role === "student" ? studentUserId(req.user) : teacherUserId(req.user)
  return { role, userId }
}

export async function createNotification(input: CreateNotificationInput): Promise<void> {
  if (!input.userId) return
  await pool.query<ResultSetHeader>(
    `INSERT INTO lms_notifications (user_role, user_id, type, title, body, link, i18n_key, i18n_params)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.role,
      input.userId,
      input.type,
      input.title.slice(0, 255),
      input.body ?? null,
      input.link ?? null,
      input.i18nKey ?? null,
      input.i18nParams ? JSON.stringify(input.i18nParams) : null,
    ]
  )
}

/** Xato bo'lsa asosiy amalni to'xtatmaydi (bildirishnoma — qo'shimcha). */
export function notifySafe(input: CreateNotificationInput): void {
  createNotification(input).catch((err) => {
    console.warn("[notifications] yozilmadi:", (err as { message?: string })?.message ?? err)
  })
}

export async function listNotifications(owner: NotificationOwner, limit = 100) {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_notifications
     WHERE user_role = ? AND user_id = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [owner.role, owner.userId, limit]
  )
  return rows.map((r) => {
    let params: Record<string, string | number> | null = null
    if (r.i18n_params) {
      try {
        params = typeof r.i18n_params === "string" ? JSON.parse(r.i18n_params) : r.i18n_params
      } catch { params = null }
    }
    return {
      id: String(r.id),
      type: String(r.type),
      title: String(r.title),
      body: r.body ? String(r.body) : "",
      link: r.link ? String(r.link) : null,
      i18nKey: r.i18n_key ? String(r.i18n_key) : null,
      i18nParams: params,
      time: new Date(r.created_at).toISOString(),
      read: !!r.is_read,
    }
  })
}

export async function unreadCount(owner: NotificationOwner): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM lms_notifications WHERE user_role = ? AND user_id = ? AND is_read = 0",
    [owner.role, owner.userId]
  )
  return Number(rows[0]?.n ?? 0)
}

/** Faqat o'ziga tegishli bildirishnomani o'zgartiradi — boshqaniki bo'lsa false. */
export async function markRead(owner: NotificationOwner, id: number): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    "UPDATE lms_notifications SET is_read = 1 WHERE id = ? AND user_role = ? AND user_id = ?",
    [id, owner.role, owner.userId]
  )
  return result.affectedRows > 0
}

export async function markAllRead(owner: NotificationOwner): Promise<void> {
  await pool.query(
    "UPDATE lms_notifications SET is_read = 1 WHERE user_role = ? AND user_id = ? AND is_read = 0",
    [owner.role, owner.userId]
  )
}

export async function deleteNotification(owner: NotificationOwner, id: number): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    "DELETE FROM lms_notifications WHERE id = ? AND user_role = ? AND user_id = ?",
    [id, owner.role, owner.userId]
  )
  return result.affectedRows > 0
}
