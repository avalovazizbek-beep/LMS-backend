import type { RowDataPacket } from "mysql2"
import { pool } from "./db"
import type { AcademicDebtor } from "../routes/hemis"

export interface ReeduGroup {
  id: number
  name: string
  subjectName: string
  teacherUserId: number | null
  teacherFullName: string | null
  semester: string | null
  status: "active" | "closed"
  createdBy: string | null
  createdAt: string
  studentCount: number
}

export interface ReeduEnrollment {
  id: number
  reeduGroupId: number
  studentUserId: number
  studentFullName: string
  studentIdNumber: string | null
  subjectName: string
  originalGroupId: number
  originalGroupName: string | null
  semester: string | null
  debtorTotalPoint: number | null
  status: "active" | "completed" | "failed"
  finalScore: number | null
  createdAt: string
}

export interface ReeduScheduleSlot {
  id: number
  reeduGroupId: number
  weekDay: number
  startTime: string
  endTime: string
  room: string | null
}

export interface ReeduAttendanceRow {
  id: number
  reeduGroupId: number
  studentUserId: number
  lessonDate: string
  status: "present" | "absent" | "late" | "excused"
}

export type ReeduGradeType = "JN" | "ON1" | "ON2" | "YN"

export interface ReeduGradeRow {
  reeduGroupId: number
  studentUserId: number
  gradeType: ReeduGradeType
  grade: number | null
}

/* ── 1-bosqich: Akademik qarzdorlarni topish — allaqachon shu fan/guruh
   bo'yicha "active" enrollment bor bo'lganlarni belgilab qo'yadi ────── */
export async function markAlreadyEnrolled(debtors: AcademicDebtor[]): Promise<(AcademicDebtor & { alreadyEnrolled: boolean })[]> {
  if (!debtors.length) return []
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT student_user_id, subject_name, original_group_id FROM lms_reedu_enrollments WHERE status = 'active'`
  )
  const enrolledKeys = new Set(rows.map((r) => `${r.student_user_id}:${r.subject_name}:${r.original_group_id}`))
  return debtors.map((d) => ({
    ...d,
    alreadyEnrolled: enrolledKeys.has(`${d.studentUserId}:${d.subjectName}:${d.groupId}`),
  }))
}

/* ── 2-bosqich: Reedu guruh yaratish/boshqarish ─────────────────────── */
export async function createReeduGroup(input: {
  name: string
  subjectName: string
  teacherUserId?: number | null
  teacherFullName?: string | null
  semester?: string | null
  createdBy?: string | null
}): Promise<number> {
  const [result] = await pool.query<any>(
    `INSERT INTO lms_reedu_groups (name, subject_name, teacher_user_id, teacher_full_name, semester, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.name, input.subjectName, input.teacherUserId ?? null, input.teacherFullName ?? null, input.semester ?? null, input.createdBy ?? null]
  )
  return result.insertId as number
}

export async function listReeduGroups(): Promise<ReeduGroup[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT g.*, (SELECT COUNT(*) FROM lms_reedu_enrollments e WHERE e.reedu_group_id = g.id AND e.status = 'active') AS student_count
     FROM lms_reedu_groups g ORDER BY g.created_at DESC`
  )
  return rows.map(mapGroupRow)
}

export async function getReeduGroup(id: number): Promise<ReeduGroup | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT g.*, (SELECT COUNT(*) FROM lms_reedu_enrollments e WHERE e.reedu_group_id = g.id AND e.status = 'active') AS student_count
     FROM lms_reedu_groups g WHERE g.id = ?`,
    [id]
  )
  return rows[0] ? mapGroupRow(rows[0]) : null
}

export async function closeReeduGroup(id: number): Promise<void> {
  await pool.query(`UPDATE lms_reedu_groups SET status = 'closed' WHERE id = ?`, [id])
}

function mapGroupRow(r: RowDataPacket): ReeduGroup {
  return {
    id: Number(r.id),
    name: String(r.name),
    subjectName: String(r.subject_name),
    teacherUserId: r.teacher_user_id !== null ? Number(r.teacher_user_id) : null,
    teacherFullName: r.teacher_full_name ?? null,
    semester: r.semester ?? null,
    status: r.status,
    createdBy: r.created_by ?? null,
    createdAt: String(r.created_at),
    studentCount: Number(r.student_count ?? 0),
  }
}

/* ── Talabalarni reedu guruhga biriktirish ──────────────────────────── */
export async function enrollDebtors(reeduGroupId: number, debtors: AcademicDebtor[], createdBy?: string | null): Promise<number> {
  if (!debtors.length) return 0
  let inserted = 0
  for (const d of debtors) {
    const [result] = await pool.query<any>(
      `INSERT IGNORE INTO lms_reedu_enrollments
         (reedu_group_id, student_user_id, student_full_name, student_id_number, subject_name,
          original_group_id, original_group_name, semester, debtor_total_point, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reeduGroupId, d.studentUserId, d.studentFullName, d.studentIdNumber, d.subjectName,
        d.groupId, d.groupName, d.semester, d.totalPoint, createdBy ?? null,
      ]
    )
    inserted += result.affectedRows ?? 0
  }
  return inserted
}

export async function listEnrollments(reeduGroupId: number): Promise<ReeduEnrollment[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_reedu_enrollments WHERE reedu_group_id = ? ORDER BY student_full_name`,
    [reeduGroupId]
  )
  return rows.map(mapEnrollmentRow)
}

export async function getStudentEnrollments(studentUserId: number): Promise<(ReeduEnrollment & { groupName: string; teacherFullName: string | null })[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT e.*, g.name AS reedu_group_name, g.teacher_full_name
     FROM lms_reedu_enrollments e
     JOIN lms_reedu_groups g ON g.id = e.reedu_group_id
     WHERE e.student_user_id = ?
     ORDER BY e.created_at DESC`,
    [studentUserId]
  )
  return rows.map((r) => ({ ...mapEnrollmentRow(r), groupName: String(r.reedu_group_name), teacherFullName: r.teacher_full_name ?? null }))
}

function mapEnrollmentRow(r: RowDataPacket): ReeduEnrollment {
  return {
    id: Number(r.id),
    reeduGroupId: Number(r.reedu_group_id),
    studentUserId: Number(r.student_user_id),
    studentFullName: String(r.student_full_name),
    studentIdNumber: r.student_id_number ?? null,
    subjectName: String(r.subject_name),
    originalGroupId: Number(r.original_group_id),
    originalGroupName: r.original_group_name ?? null,
    semester: r.semester ?? null,
    debtorTotalPoint: r.debtor_total_point !== null ? Number(r.debtor_total_point) : null,
    status: r.status,
    finalScore: r.final_score !== null ? Number(r.final_score) : null,
    createdAt: String(r.created_at),
  }
}

/* ── 3-bosqich: Dars jadvali ─────────────────────────────────────────── */
export async function setReeduSchedule(reeduGroupId: number, slots: { weekDay: number; startTime: string; endTime: string; room?: string | null }[]): Promise<void> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`DELETE FROM lms_reedu_schedule WHERE reedu_group_id = ?`, [reeduGroupId])
    for (const s of slots) {
      await conn.query(
        `INSERT INTO lms_reedu_schedule (reedu_group_id, week_day, start_time, end_time, room) VALUES (?, ?, ?, ?, ?)`,
        [reeduGroupId, s.weekDay, s.startTime, s.endTime, s.room ?? null]
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function getReeduSchedule(reeduGroupId: number): Promise<ReeduScheduleSlot[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_reedu_schedule WHERE reedu_group_id = ? ORDER BY week_day, start_time`,
    [reeduGroupId]
  )
  return rows.map((r) => ({
    id: Number(r.id), reeduGroupId: Number(r.reedu_group_id), weekDay: Number(r.week_day),
    startTime: String(r.start_time), endTime: String(r.end_time), room: r.room ?? null,
  }))
}

/* ── 4-bosqich: Davomat ──────────────────────────────────────────────── */
export async function markReeduAttendance(reeduGroupId: number, lessonDate: string, records: { studentUserId: number; status: "present" | "absent" | "late" | "excused" }[], markedBy?: string | null): Promise<void> {
  for (const r of records) {
    await pool.query(
      `INSERT INTO lms_reedu_attendance (reedu_group_id, student_user_id, lesson_date, status, marked_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), marked_by = VALUES(marked_by)`,
      [reeduGroupId, r.studentUserId, lessonDate, r.status, markedBy ?? null]
    )
  }
}

export async function getReeduAttendance(reeduGroupId: number): Promise<ReeduAttendanceRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_reedu_attendance WHERE reedu_group_id = ? ORDER BY lesson_date DESC`,
    [reeduGroupId]
  )
  return rows.map((r) => ({
    id: Number(r.id), reeduGroupId: Number(r.reedu_group_id), studentUserId: Number(r.student_user_id),
    lessonDate: String(r.lesson_date), status: r.status,
  }))
}

export async function getReeduAttendanceSummary(reeduGroupId: number): Promise<Map<number, { present: number; total: number }>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT student_user_id,
            SUM(CASE WHEN status IN ('present','late') THEN 1 ELSE 0 END) AS present,
            COUNT(*) AS total
     FROM lms_reedu_attendance WHERE reedu_group_id = ? GROUP BY student_user_id`,
    [reeduGroupId]
  )
  const map = new Map<number, { present: number; total: number }>()
  for (const r of rows) map.set(Number(r.student_user_id), { present: Number(r.present), total: Number(r.total) })
  return map
}

/* ── 5-bosqich: Nazorat (JN/ON1/ON2/YN) ─────────────────────────────── */
export async function upsertReeduGrade(reeduGroupId: number, studentUserId: number, gradeType: ReeduGradeType, grade: number | null, updatedBy?: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO lms_reedu_grades (reedu_group_id, student_user_id, grade_type, grade, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE grade = VALUES(grade), updated_by = VALUES(updated_by)`,
    [reeduGroupId, studentUserId, gradeType, grade, updatedBy ?? null]
  )
}

export async function getReeduGrades(reeduGroupId: number): Promise<ReeduGradeRow[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT reedu_group_id, student_user_id, grade_type, grade FROM lms_reedu_grades WHERE reedu_group_id = ?`,
    [reeduGroupId]
  )
  return rows.map((r) => ({
    reeduGroupId: Number(r.reedu_group_id), studentUserId: Number(r.student_user_id),
    gradeType: r.grade_type, grade: r.grade !== null ? Number(r.grade) : null,
  }))
}

/* ── 6-bosqich: Yakunlash — JN+ON1+ON2+YN o'rtachasi 55dan yuqori bo'lsa
   "completed", aks holda "failed" deb belgilanadi. HEMIS'ning o'zi tashqi
   tizimlardan yozish (POST) imkonini bermaydi (admin.ts /hemis-sync
   izohida ham qayd etilgan) — shu sabab bu "qaydnoma" faqat LMS ichida
   yakuniy hisobot sifatida saqlanadi, HEMIS'ga avtomatik yuborilmaydi. ──*/
export async function finalizeReeduEnrollment(reeduGroupId: number, studentUserId: number): Promise<{ finalScore: number; status: "completed" | "failed" } | null> {
  const grades = await getReeduGrades(reeduGroupId)
  const own = grades.filter((g) => g.studentUserId === studentUserId && g.grade !== null)
  if (!own.length) return null
  const finalScore = Math.round((own.reduce((s, g) => s + (g.grade ?? 0), 0) / own.length) * 10) / 10
  const status = finalScore >= 55 ? "completed" : "failed"
  await pool.query(
    `UPDATE lms_reedu_enrollments SET final_score = ?, status = ?, completed_at = NOW()
     WHERE reedu_group_id = ? AND student_user_id = ?`,
    [finalScore, status, reeduGroupId, studentUserId]
  )
  return { finalScore, status }
}

/* ── Qaydnoma (HEMIS uchun eksport ma'lumoti) ───────────────────────── */
export async function getReeduRecordExport(reeduGroupId: number) {
  const enrollments = await listEnrollments(reeduGroupId)
  return enrollments.map((e) => ({
    studentFullName: e.studentFullName,
    studentIdNumber: e.studentIdNumber,
    subjectName: e.subjectName,
    originalGroupName: e.originalGroupName,
    debtorTotalPoint: e.debtorTotalPoint,
    finalScore: e.finalScore,
    status: e.status,
    readyForHemis: e.status !== "active" && e.finalScore !== null,
  }))
}
