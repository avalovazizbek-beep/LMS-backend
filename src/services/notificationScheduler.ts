import type { RowDataPacket } from "mysql2"
import { pool } from "./db"
import { createNotification, studentOwnersInGroups, type NotificationOwner } from "./notificationStore"

/**
 * Vaqtga bog'liq eslatmalar — har daqiqada tekshiriladi:
 *  • dars (meeting) 15 daqiqadan keyin boshlanadi — o'qituvchi va guruh talabalariga;
 *  • test/topshiriq muddatiga 24 soat va 1 soat qoldi — hali topshirmagan talabalarga.
 * Har eslatma dedupe_key bilan bir marta yuboriladi (server qayta ishga tushsa ham).
 * Sana-vaqtlar JS Date sifatida uzatiladi — bazaga qanday yozilgan bo'lsa
 * (server mahalliy vaqti, Asia/Tashkent), shunday solishtiriladi.
 */

const TICK_MS = 60_000
const MEETING_LEAD_MIN = 15

let running = false

function pad(n: number) {
  return String(n).padStart(2, "0")
}

/** "25.09 14:30" — server mahalliy vaqtida (Asia/Tashkent) */
function shortDateTime(value: unknown): string {
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return ""
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

async function notifyAll(owners: NotificationOwner[], build: (o: NotificationOwner) => Parameters<typeof createNotification>[0]) {
  for (const owner of owners) {
    try {
      await createNotification(build(owner))
    } catch (err) {
      console.warn("[notif scheduler] yuborilmadi:", (err as { message?: string })?.message ?? err)
    }
  }
}

async function meetingReminders(now: Date) {
  const until = new Date(now.getTime() + MEETING_LEAD_MIN * 60_000)
  const [meetings] = await pool.query<RowDataPacket[]>(
    `SELECT id, title, created_by_user_id, start_time FROM lms_meetings
     WHERE status = 'scheduled' AND start_time > ? AND start_time <= ?`,
    [now, until]
  )
  for (const m of meetings) {
    const [groupRows] = await pool.query<RowDataPacket[]>(
      "SELECT group_id FROM lms_meeting_groups WHERE meeting_id = ?",
      [m.id]
    )
    const students = await studentOwnersInGroups(groupRows.map((g) => Number(g.group_id)))
    const owners: NotificationOwner[] = [{ role: "employee", userId: Number(m.created_by_user_id) }, ...students]
    const time = shortDateTime(m.start_time)
    await notifyAll(owners, (owner) => ({
      ...owner,
      type: "schedule",
      title: "Dars tez orada boshlanadi",
      body: `${m.title} — ${time}`,
      link: "/meeting",
      i18nKey: "meetingSoon",
      i18nParams: { title: String(m.title), time },
      dedupeKey: `meeting-soon:${m.id}`,
    }))
  }
}

async function deadlineReminders(now: Date) {
  const windows = [
    { key: "24h", hours: 24, i18nKey: "deadline24h", title: "Topshirish muddatiga 1 kun qoldi" },
    { key: "1h", hours: 1, i18nKey: "deadline1h", title: "Topshirish muddatiga 1 soat qoldi" },
  ]
  for (const w of windows) {
    const until = new Date(now.getTime() + w.hours * 3_600_000)
    const [contents] = await pool.query<RowDataPacket[]>(
      `SELECT id, title, type, group_id, deadline FROM lms_teacher_content
       WHERE is_active = 1 AND type IN ('exam','assignment') AND group_id IS NOT NULL
         AND deadline IS NOT NULL AND available_from <= ? AND deadline > ? AND deadline <= ?`,
      [now, now, until]
    )
    for (const c of contents) {
      const students = await studentOwnersInGroups([Number(c.group_id)])
      if (!students.length) continue
      // Allaqachon topshirganlarga eslatilmaydi
      const [done] = await pool.query<RowDataPacket[]>(
        "SELECT student_user_id FROM lms_submissions WHERE content_id = ?",
        [c.id]
      )
      const submitted = new Set(done.map((r) => Number(r.student_user_id)))
      const pending = students.filter((s) => !submitted.has(s.userId))
      const time = shortDateTime(c.deadline)
      await notifyAll(pending, (owner) => ({
        ...owner,
        type: "reminder",
        title: w.title,
        body: `${c.title} — ${time}`,
        link: c.type === "exam" ? "/imtihonlar" : "/topshiriqlar",
        i18nKey: w.i18nKey,
        i18nParams: { title: String(c.title), time },
        dedupeKey: `deadline-${w.key}:${c.id}`,
      }))
    }
  }
}

/** Bir martalik tekshiruv — rejalashtiruvchi va qo'lda sinash uchun. */
export async function runNotificationTick() {
  if (running) return
  running = true
  const now = new Date()
  try {
    await meetingReminders(now)
    await deadlineReminders(now)
  } catch (err) {
    console.warn("[notif scheduler] xato:", (err as { message?: string })?.message ?? err)
  } finally {
    running = false
  }
}

export function startNotificationScheduler() {
  setTimeout(() => void runNotificationTick(), 20_000)
  setInterval(() => void runNotificationTick(), TICK_MS)
}

/** Yangi dars rejalashtirilganda guruh talabalariga xabar (meeting yaratilganda). */
export async function notifyMeetingCreated(meeting: { id: number; title: string; startTime: string }, groupIds: number[]) {
  const students = await studentOwnersInGroups(groupIds)
  const time = shortDateTime(meeting.startTime)
  await notifyAll(students, (owner) => ({
    ...owner,
    type: "schedule",
    title: "Yangi dars rejalashtirildi",
    body: `${meeting.title} — ${time}`,
    link: "/meeting",
    i18nKey: "meetingNew",
    i18nParams: { title: meeting.title, time },
    dedupeKey: `meeting-new:${meeting.id}`,
  }))
}
