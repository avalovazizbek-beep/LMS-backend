import type mysql from "mysql2/promise"
import { pool } from "./db"

/* ── MySQL DATE ustunini "YYYY-MM-DD" ko'rinishiga o'tkazish ─────────── */
function toDateOnly(value: unknown): string {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0")
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  return String(value).slice(0, 10)
}

/* ── Bahoni saqlash ─────────────────────────────────────────────────── */
export interface GradeRecordInput {
  studentUserId: number
  fullName: string
  grade: number | null
  comment?: string | null
}

export async function saveGrade(
  groupId: number,
  subjectName: string,
  lessonDate: string,
  records: GradeRecordInput[],
  markedByUserId: number
) {
  for (const r of records) {
    await pool.query(
      `INSERT INTO lms_grades
        (group_id, subject_name, lesson_date, student_user_id, student_full_name, grade, comment, marked_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         student_full_name = VALUES(student_full_name),
         grade             = VALUES(grade),
         comment           = VALUES(comment),
         marked_by_user_id = VALUES(marked_by_user_id)`,
      [groupId, subjectName.trim(), lessonDate, r.studentUserId, r.fullName, r.grade, r.comment?.trim() || null, markedByUserId]
    )
  }
}

/* ── Bir kunlik baholar (o'qituvchi uchun roster bilan birlashtirish) ── */
export interface GradeRecord {
  studentUserId: number
  grade: number | null
  comment: string | null
}

export async function getGradeForGroupDate(
  groupId: number,
  subjectName: string,
  lessonDate: string
): Promise<Map<number, GradeRecord>> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT student_user_id, grade, comment FROM lms_grades WHERE group_id = ? AND subject_name = ? AND lesson_date = ?",
    [groupId, subjectName.trim(), lessonDate]
  )
  const map = new Map<number, GradeRecord>()
  for (const row of rows) {
    map.set(Number(row.student_user_id), {
      studentUserId: Number(row.student_user_id),
      grade: row.grade === null ? null : Number(row.grade),
      comment: row.comment ?? null,
    })
  }
  return map
}

/* ── O'qituvchi uchun tarix/hisobot ─────────────────────────────────── */
export interface GradeHistoryEntry {
  lessonDate: string
  subjectName: string
  records: {
    studentUserId: number
    studentFullName: string
    grade: number | null
    comment: string | null
  }[]
}

export async function getGroupGradeHistory(
  groupId: number,
  subjectName?: string,
  from?: string,
  to?: string
): Promise<GradeHistoryEntry[]> {
  const where = ["group_id = ?"]
  const params: unknown[] = [groupId]
  if (subjectName?.trim()) {
    where.push("subject_name = ?")
    params.push(subjectName.trim())
  }
  if (from) {
    where.push("lesson_date >= ?")
    params.push(from)
  }
  if (to) {
    where.push("lesson_date <= ?")
    params.push(to)
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT * FROM lms_grades WHERE ${where.join(" AND ")} ORDER BY lesson_date DESC, student_full_name`,
    params
  )

  const map = new Map<string, GradeHistoryEntry>()
  for (const row of rows) {
    const lessonDate = toDateOnly(row.lesson_date)
    const key = `${lessonDate}__${row.subject_name}`
    if (!map.has(key)) {
      map.set(key, { lessonDate, subjectName: String(row.subject_name), records: [] })
    }
    map.get(key)!.records.push({
      studentUserId: Number(row.student_user_id),
      studentFullName: String(row.student_full_name),
      grade: row.grade === null ? null : Number(row.grade),
      comment: row.comment ?? null,
    })
  }
  return Array.from(map.values())
}
