import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { pool } from "./db"
import { teacherUserId, studentUserId } from "./teachingStore"
import { hasPermission, type AdminModule } from "./permissionsStore"
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
  /** Bir xil kalit bilan ikkinchi marta yuborilmaydi (eslatmalar uchun) */
  dedupeKey?: string | null
}

/** So'rov egasini aniqlaydi: talaba — studentUserId, qolganlar — teacherUserId. */
export function notificationOwnerOf(req: AuthRequest): NotificationOwner {
  const role = req.user?.role === "student" ? "student" : String(req.user?.role || "employee")
  const userId = role === "student" ? studentUserId(req.user) : teacherUserId(req.user)
  return { role, userId }
}

export async function createNotification(input: CreateNotificationInput): Promise<void> {
  if (!input.userId) return
  // dedupeKey bo'lsa — (egasi, kalit) noyob: takroriy eslatma jim o'tkaziladi
  await pool.query<ResultSetHeader>(
    `INSERT ${input.dedupeKey ? "IGNORE " : ""}INTO lms_notifications
       (user_role, user_id, type, title, body, link, i18n_key, i18n_params, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.role,
      input.userId,
      input.type,
      input.title.slice(0, 255),
      input.body ?? null,
      input.link ?? null,
      input.i18nKey ?? null,
      input.i18nParams ? JSON.stringify(input.i18nParams) : null,
      input.dedupeKey ?? null,
    ]
  )
}

/**
 * O'qilmagan bir turdagi xabarlarni bittaga yig'adi: egasida shu groupKey
 * bilan o'qilmagan bildirishnoma bo'lsa — hisob (n) oshiriladi va xabar
 * yuqoriga ko'tariladi, bo'lmasa n = 1 bilan yangisi yaratiladi.
 * Masalan: 30 ta talaba topshiriq yuborsa, o'qituvchida 30 ta emas, bitta
 * "30 ta ish baholashni kutmoqda" xabari turadi.
 */
export async function bumpGroupedNotification(
  input: Omit<CreateNotificationInput, "title" | "body" | "i18nParams" | "dedupeKey"> & {
    groupKey: string
    params?: Record<string, string | number>
    /** n (hisob) bo'yicha o'zbekcha zaxira matn */
    text: (n: number) => { title: string; body: string }
  }
): Promise<void> {
  if (!input.userId) return
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, i18n_params FROM lms_notifications
     WHERE user_role = ? AND user_id = ? AND group_key = ? AND is_read = 0
     ORDER BY id DESC LIMIT 1`,
    [input.role, input.userId, input.groupKey]
  )
  const existing = rows[0]
  let prevN = 0
  if (existing?.i18n_params) {
    try {
      const p = typeof existing.i18n_params === "string" ? JSON.parse(existing.i18n_params) : existing.i18n_params
      prevN = Number(p?.n) || 0
    } catch { prevN = 0 }
  }
  const n = prevN + 1
  const params = { ...(input.params ?? {}), n }
  const { title, body } = input.text(n)
  if (existing) {
    await pool.query(
      `UPDATE lms_notifications SET title = ?, body = ?, i18n_params = ?, link = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [title.slice(0, 255), body, JSON.stringify(params), input.link ?? null, existing.id]
    )
    return
  }
  await pool.query<ResultSetHeader>(
    `INSERT INTO lms_notifications (user_role, user_id, type, title, body, link, i18n_key, i18n_params, group_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.role, input.userId, input.type, title.slice(0, 255), body, input.link ?? null,
      input.i18nKey ?? null, JSON.stringify(params), input.groupKey]
  )
}

export function bumpGroupedSafe(input: Parameters<typeof bumpGroupedNotification>[0]): void {
  bumpGroupedNotification(input).catch((err) => {
    console.warn("[notifications] yig'ilmadi:", (err as { message?: string })?.message ?? err)
  })
}

/**
 * Admin panel bo'limi (module) bo'yicha xabar oluvchilar: barcha adminlar
 * (lms_permissions + o'zgarmas admin) va shu bo'limni ko'rish huquqi bor
 * dekanlar. Egasi — xodim roli (admin/dekan HEMIS xodim sifatida kiradi).
 */
export async function adminOwnersFor(module: AdminModule): Promise<NotificationOwner[]> {
  const owners = new Map<string, NotificationOwner>()
  const deanCanView = await hasPermission("dean", module, "view").catch(() => false)
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT hemis_id, hemis_role, lms_role FROM lms_permissions WHERE lms_role IN ('admin','dean')"
  )
  for (const r of rows) {
    if (r.lms_role === "dean" && !deanCanView) continue
    const userId = Number(r.hemis_id)
    if (!Number.isFinite(userId) || userId <= 0) continue
    const role = r.hemis_role === "student" ? "student" : "employee"
    owners.set(`${role}:${userId}`, { role, userId })
  }
  const fixedAdmin = Number(String(process.env.FIXED_ADMIN_HEMIS_ID ?? "").trim())
  if (Number.isFinite(fixedAdmin) && fixedAdmin > 0) owners.set(`employee:${fixedAdmin}`, { role: "employee", userId: fixedAdmin })
  return [...owners.values()]
}

/** Guruh(lar)dagi talabalar — platformaga kirgan talabalar sessiyalaridan. */
export async function studentOwnersInGroups(groupIds: number[]): Promise<NotificationOwner[]> {
  const ids = groupIds.filter((g) => Number.isFinite(g) && g > 0)
  if (!ids.length) return []
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT DISTINCT user_id FROM lms_platform_sessions WHERE role = 'student' AND group_id IN (?)",
    [ids]
  )
  return rows.map((r) => ({ role: "student", userId: Number(r.user_id) })).filter((o) => o.userId > 0)
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
