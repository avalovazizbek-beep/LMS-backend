import type mysql from "mysql2/promise"
import { pool, toMysqlDate, fromMysqlDate } from "./db"

/* ── HEMIS'da "Bekor qilingan" talabalar va ularning LMS'ga kirish bloki ──
 * HEMIS classifier h_student_status: 11 O'qimoqda, 12 Chetlashgan, 13 Akademik
 * ta'til, 14 Bitirgan, ..., 17 Bekor qilingan (2026-11-06 jonli tekshirildi).
 * Ro'yxat hemisSync.syncCancelledStudents orqali /v1/data/student-list
 * ?_student_status=17 dan olinadi. Yangi kelgan talaba avtomatik bloklanadi;
 * admin "Talabalar ro'yxati" sahifasidan blokdan chiqarishi yoki qayta
 * bloklashi mumkin. HEMIS'da tiklangan (ro'yxatdan tushgan) talabaga blok
 * qo'llanmaydi (in_hemis_list = 0).
 *
 * Buyruq raqami/sanasi admin tokeni bilan HEMIS'dan olinmaydi: student-list,
 * student-info va student-meta-log-list'da (_status_change_reason doim null)
 * yo'q, /ver1/tutor/student/history esa tutor tokenini talab qiladi — shu
 * sabab admin qo'lda kiritadi. */

export const CANCELLED_STATUS_CODE = "17"
export const MASOFAVIY_FORM_CODE = "16"

export const STUDENT_CANCELLED_CODE = "student_cancelled"
export const STUDENT_CANCELLED_MESSAGE =
  "Siz talabalar safidan chetlatilgansiz — siz uchun bu yerda sahifa mavjud emas. Savollaringiz bo'lsa, fakultet dekanatiga murojaat qiling."

export interface CancelledStudentInput {
  student_id_number: string
  hemis_id: number | null
  full_name: string
  group_id: number | null
  group_name: string | null
  department: string | null
  specialty: string | null
  level_name: string | null
  education_form_code: string | null
  education_form_name: string | null
  payment_form: string | null
  status_code: string | null
  status_name: string | null
  hemis_updated_at: Date | null
}

export interface CancelledStudent {
  studentIdNumber: string
  hemisId: number | null
  fullName: string
  groupName: string | null
  department: string | null
  specialty: string | null
  levelName: string | null
  educationFormName: string | null
  paymentForm: string | null
  statusName: string | null
  hemisUpdatedAt: string | null
  blocked: boolean
  blockSource: "auto" | "admin"
  blockChangedByName: string | null
  blockChangedAt: string | null
  decreeNumber: string | null
  decreeDate: string | null
  note: string | null
  firstSeenAt: string
}

function dateOnly(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  const s = String(value)
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null
}

function mapRow(r: mysql.RowDataPacket): CancelledStudent {
  return {
    studentIdNumber: String(r.student_id_number),
    hemisId: r.hemis_id != null ? Number(r.hemis_id) : null,
    fullName: String(r.full_name),
    groupName: r.group_name ?? null,
    department: r.department ?? null,
    specialty: r.specialty ?? null,
    levelName: r.level_name ?? null,
    educationFormName: r.education_form_name ?? null,
    paymentForm: r.payment_form ?? null,
    statusName: r.status_name ?? null,
    hemisUpdatedAt: r.hemis_updated_at ? fromMysqlDate(r.hemis_updated_at) : null,
    blocked: Boolean(r.blocked),
    blockSource: r.block_source === "admin" ? "admin" : "auto",
    blockChangedByName: r.block_changed_by_name ?? null,
    blockChangedAt: r.block_changed_at ? fromMysqlDate(r.block_changed_at) : null,
    decreeNumber: r.decree_number ?? null,
    decreeDate: dateOnly(r.decree_date),
    note: r.note ?? null,
    firstSeenAt: fromMysqlDate(r.first_seen_at),
  }
}

/* ── Bloklanganlar keshi (authMiddleware har so'rovda tekshiradi) ─────── */
const RELOAD_INTERVAL_MS = 60_000
let blockedIds = new Set<string>()
let loadedAt = 0
let reloading: Promise<void> | null = null

export function reloadBlockedStudents(): Promise<void> {
  if (reloading) return reloading
  reloading = (async () => {
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT student_id_number FROM lms_student_cancellations WHERE blocked = 1 AND in_hemis_list = 1"
      )
      blockedIds = new Set(rows.map((r) => String(r.student_id_number).trim()))
      loadedAt = Date.now()
    } catch (err) {
      // Jadval hali yo'q yoki DB vaqtincha javob bermadi — eski kesh qoladi
      loadedAt = Date.now()
      console.warn("[studentCancellation] bloklanganlar ro'yxatini o'qib bo'lmadi:", err instanceof Error ? err.message : err)
    } finally {
      reloading = null
    }
  })()
  return reloading
}

/** Sinxron, DB'ga bormaydi — kesh eskirgan bo'lsa fonda yangilanadi.
 *  Bir nechta PM2 jarayonida ham ko'pi bilan 1 daqiqa kechikadi. */
export function isBlockedCached(ids: Array<unknown>): boolean {
  if (Date.now() - loadedAt > RELOAD_INTERVAL_MS) void reloadBlockedStudents()
  if (!blockedIds.size) return false
  return ids.some((id) => (typeof id === "string" || typeof id === "number") && blockedIds.has(String(id).trim()))
}

/** Login paytida — to'g'ridan-to'g'ri DB'dan (keshni kutmaydi). */
export async function isStudentBlocked(studentIdNumber?: string | null): Promise<boolean> {
  const sid = studentIdNumber?.trim()
  if (!sid) return false
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT 1 FROM lms_student_cancellations WHERE student_id_number = ? AND blocked = 1 AND in_hemis_list = 1 LIMIT 1",
    [sid]
  )
  return rows.length > 0
}

/** Admin blokdan chiqargan masofaviy talaba. HEMIS'ning faol (11) ro'yxatida
 *  yo'qligi uchun katalogda is_active = 0 — masofaviy tekshiruvi shu orqali
 *  uni baribir o'tkazadi (aks holda "kunduzgi" xabarini ko'rardi). */
export async function isUnblockedCancelledMasofaviy(studentIdNumber?: string | null): Promise<boolean> {
  const sid = studentIdNumber?.trim()
  if (!sid) return false
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT 1 FROM lms_student_cancellations
     WHERE student_id_number = ? AND blocked = 0 AND in_hemis_list = 1 AND education_form_code = ? LIMIT 1`,
    [sid, MASOFAVIY_FORM_CODE]
  )
  return rows.length > 0
}

/** HEMIS'dan kelgan to'liq "Bekor qilingan" ro'yxatini yozadi. Yangi qator
 *  bloklangan holda qo'shiladi; mavjudining admin qarori (blocked) saqlanadi,
 *  faqat oldin ro'yxatdan tushib, endi qaytgan bo'lsa qaytadan bloklanadi.
 *  Shu yugurishda kelmaganlar in_hemis_list = 0 qilinadi. */
export async function saveCancelledStudents(rows: CancelledStudentInput[], runStartedAt: Date): Promise<{ added: number; removed: number }> {
  let added = 0
  for (const r of rows) {
    const [result] = await pool.query(
      `INSERT INTO lms_student_cancellations
         (student_id_number, hemis_id, full_name, group_id, group_name, department, specialty, level_name,
          education_form_code, education_form_name, payment_form, status_code, status_name, hemis_updated_at,
          in_hemis_list, blocked, block_source, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'auto', CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE
         blocked = IF(in_hemis_list = 0, 1, blocked),
         block_source = IF(in_hemis_list = 0, 'auto', block_source),
         in_hemis_list = 1,
         hemis_id = VALUES(hemis_id),
         full_name = VALUES(full_name),
         group_id = VALUES(group_id),
         group_name = VALUES(group_name),
         department = VALUES(department),
         specialty = VALUES(specialty),
         level_name = VALUES(level_name),
         education_form_code = VALUES(education_form_code),
         education_form_name = VALUES(education_form_name),
         payment_form = VALUES(payment_form),
         status_code = VALUES(status_code),
         status_name = VALUES(status_name),
         hemis_updated_at = VALUES(hemis_updated_at),
         synced_at = CURRENT_TIMESTAMP`,
      [
        r.student_id_number, r.hemis_id, r.full_name, r.group_id, r.group_name, r.department, r.specialty, r.level_name,
        r.education_form_code, r.education_form_name, r.payment_form, r.status_code, r.status_name,
        r.hemis_updated_at ? toMysqlDate(r.hemis_updated_at) : null,
      ]
    )
    // INSERT → 1, UPDATE → 2 (o'zgarmagan bo'lsa 0)
    if ((result as mysql.ResultSetHeader).affectedRows === 1) added++
  }

  const [stale] = await pool.query(
    "UPDATE lms_student_cancellations SET in_hemis_list = 0 WHERE in_hemis_list = 1 AND synced_at < ?",
    [toMysqlDate(runStartedAt)]
  )
  await reloadBlockedStudents()
  return { added, removed: (stale as mysql.ResultSetHeader).affectedRows }
}

/** Admin ro'yxati — faqat masofaviy va hozir HEMIS'da "Bekor qilingan"lar */
export async function listCancelledMasofaviy(): Promise<CancelledStudent[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT * FROM lms_student_cancellations
     WHERE in_hemis_list = 1 AND education_form_code = ?
     ORDER BY group_name, full_name`,
    [MASOFAVIY_FORM_CODE]
  )
  return rows.map(mapRow)
}

export async function getCancelledStudent(studentIdNumber: string): Promise<CancelledStudent | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_student_cancellations WHERE student_id_number = ? LIMIT 1",
    [studentIdNumber]
  )
  return rows.length ? mapRow(rows[0]) : null
}

export interface CancellationUpdate {
  blocked?: boolean
  decreeNumber?: string | null
  decreeDate?: string | null
  note?: string | null
}

export async function updateCancelledStudent(
  studentIdNumber: string,
  patch: CancellationUpdate,
  actor: { id: string; name: string | null }
): Promise<CancelledStudent | null> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.blocked !== undefined) {
    sets.push("blocked = ?", "block_source = 'admin'", "block_changed_by = ?", "block_changed_by_name = ?", "block_changed_at = NOW()")
    params.push(patch.blocked ? 1 : 0, actor.id || null, actor.name)
  }
  if (patch.decreeNumber !== undefined) { sets.push("decree_number = ?"); params.push(patch.decreeNumber?.trim().slice(0, 120) || null) }
  if (patch.decreeDate !== undefined) { sets.push("decree_date = ?"); params.push(patch.decreeDate || null) }
  if (patch.note !== undefined) { sets.push("note = ?"); params.push(patch.note?.trim().slice(0, 500) || null) }
  if (!sets.length) return getCancelledStudent(studentIdNumber)

  params.push(studentIdNumber)
  await pool.query(`UPDATE lms_student_cancellations SET ${sets.join(", ")} WHERE student_id_number = ?`, params)
  if (patch.blocked !== undefined) await reloadBlockedStudents()
  return getCancelledStudent(studentIdNumber)
}

export async function lastCancellationSyncAt(): Promise<string | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT MAX(synced_at) AS t FROM lms_student_cancellations")
  return rows[0]?.t ? fromMysqlDate(rows[0].t) : null
}
