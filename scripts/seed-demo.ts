/**
 * Demo (test) hisoblar yaratish — HEMIS orqali kirmasdan, LOGIN + PAROL bilan
 * haqiqiy login sahifasi orqali sinash uchun. Atayin minimal: faqat 2 ta
 * hisob (`demo_teacher`, `demo_student1_1`) va ular biriktirilgan bitta fan
 * ("Demo fan") — hech qanday mavzu/video/fayl/test/baho/davomat/meeting
 * seedlanmaydi.
 *
 * Ishga tushirish:
 *   npx ts-node scripts/seed-demo.ts
 *
 * O'chirish (keyinroq demolarni olib tashlash uchun):
 *   npx ts-node scripts/seed-demo.ts --remove
 */
import "dotenv/config"
import bcrypt from "bcryptjs"
import type mysql from "mysql2/promise"
import { pool, initDatabase } from "../src/services/db"
import { deleteTeacherContent, removeStoredFile } from "../src/services/teachingStore"

const TEACHER_ID = 9501
const GROUP_IDS = [9901]
const GROUP_NAMES = ["DEMO-101"]
// Faqat 1 ta talaba — demo_student1_1
const STUDENTS_PER_GROUP = [1]
// remove() uchun — bu skriptning oldingi versiyalari 9902 (DEMO-102)ni ham
// yaratgan edi; shu ro'yxat har doim TO'LIQ tozalash uchun, GROUP_IDS'dan
// mustaqil ravishda saqlanadi (GROUP_IDS kichraytirilsa ham eski qoldiqlar tozalanadi).
const ALL_KNOWN_GROUP_IDS = [9901, 9902]
const DEMO_PASSWORD = "demo12345"
const DEMO_SUBJECT = "Demo fan"
const HERO_STUDENT_USERNAME = "demo_student1_1"

async function remove() {
  await initDatabase()

  // Fayllarni (video/audio/hujjat) DB qatorlaridan OLDIN o'chiramiz — FK
  // CASCADE faqat qatorlarni tozalaydi, diskdagi fayllarni emas.

  // 1) Talabalar shu kontentga yuklagan fayllar (topshiriq javoblari)
  const [submissionFiles] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT s.relative_path FROM lms_submissions s
     JOIN lms_teacher_content c ON c.id = s.content_id
     WHERE c.teacher_user_id = ? AND s.relative_path IS NOT NULL`,
    [TEACHER_ID]
  )
  submissionFiles.forEach((row) => removeStoredFile(row.relative_path as string))

  // 2) O'qituvchi yuklagan kontent fayllari (video/audio/taqdimot/qo'llanma/topshiriq)
  const [contentRows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT id FROM lms_teacher_content WHERE teacher_user_id = ?",
    [TEACHER_ID]
  )
  for (const row of contentRows) {
    await deleteTeacherContent(Number(row.id))
  }

  // 3) Meeting yozuvlari (video)
  const [recordingFiles] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT r.relative_path FROM lms_meeting_recordings r
     JOIN lms_meetings m ON m.id = r.meeting_id
     WHERE m.created_by_user_id = ?`,
    [TEACHER_ID]
  )
  recordingFiles.forEach((row) => removeStoredFile(row.relative_path as string))

  await pool.query("DELETE FROM lms_demo_accounts WHERE hemis_id = ? OR hemis_id BETWEEN 9601 AND 9699", [TEACHER_ID])
  await pool.query("DELETE FROM hemis_users WHERE hemis_id = ? OR CAST(hemis_id AS UNSIGNED) BETWEEN 9601 AND 9699", [String(TEACHER_ID)])
  await pool.query("DELETE FROM lms_platform_sessions WHERE user_id = ? OR user_id BETWEEN 9601 AND 9699", [TEACHER_ID])
  await pool.query("DELETE FROM lms_teacher_groups WHERE user_id = ?", [TEACHER_ID])
  await pool.query("DELETE FROM lms_teacher_subjects WHERE user_id = ?", [TEACHER_ID])
  await pool.query("DELETE FROM lms_teacher_schedule WHERE teacher_user_id = ?", [TEACHER_ID])
  const groupPlaceholders = ALL_KNOWN_GROUP_IDS.map(() => "?").join(", ")
  await pool.query(`DELETE FROM lms_grades WHERE group_id IN (${groupPlaceholders})`, ALL_KNOWN_GROUP_IDS)
  await pool.query(`DELETE FROM lms_period_grades WHERE group_id IN (${groupPlaceholders})`, ALL_KNOWN_GROUP_IDS)
  await pool.query(`DELETE FROM lms_attendance WHERE group_id IN (${groupPlaceholders})`, ALL_KNOWN_GROUP_IDS)
  await pool.query("DELETE FROM face_registrations WHERE username = 'Demo Talaba 1-1'")
  // lms_meetings o'chirilishi lms_meeting_groups, lms_meeting_attendance va
  // lms_meeting_recordings'ni FK ON DELETE CASCADE orqali avtomatik tozalaydi
  // (fayllari 3-qadamda allaqachon o'chirildi)
  await pool.query("DELETE FROM lms_meetings WHERE created_by_user_id = ?", [TEACHER_ID])
  // lms_teacher_content 2-qadamda allaqachon (fayllari bilan) o'chirildi
  await pool.query(`DELETE FROM lms_groups WHERE id IN (${groupPlaceholders})`, ALL_KNOWN_GROUP_IDS)
  console.log("Demo hisoblar va ular yuklagan fayllar o'chirildi.")
  await pool.end()
}

async function seed() {
  await initDatabase()

  // 1) Guruhlar
  for (let i = 0; i < GROUP_IDS.length; i++) {
    await pool.query(
      "INSERT INTO lms_groups (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)",
      [GROUP_IDS[i], GROUP_NAMES[i]]
    )
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10)
  const credentials: { role: string; name: string; group: string | null; username: string; password: string }[] = []

  // 2) O'qituvchi
  const teacherName = "Demo O'qituvchi"
  const teacherUsername = "demo_teacher"
  await pool.query(
    `INSERT INTO hemis_users (hemis_id, role, username, full_name, teacher_user_id)
     VALUES (?, 'employee', ?, ?, ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), teacher_user_id = VALUES(teacher_user_id)`,
    [String(TEACHER_ID), teacherName, teacherName, TEACHER_ID]
  )
  await pool.query(
    `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role) VALUES (?, ?, NULL, 'employee')`,
    [TEACHER_ID, teacherName]
  )
  for (const gid of GROUP_IDS) {
    await pool.query("INSERT IGNORE INTO lms_teacher_groups (user_id, group_id) VALUES (?, ?)", [TEACHER_ID, gid])
  }
  await pool.query(
    `INSERT INTO lms_demo_accounts (username, password_hash, role, hemis_id, full_name, group_id, teacher_group_ids)
     VALUES (?, ?, 'employee', ?, ?, NULL, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), full_name = VALUES(full_name), teacher_group_ids = VALUES(teacher_group_ids)`,
    [teacherUsername, passwordHash, TEACHER_ID, teacherName, JSON.stringify(GROUP_IDS)]
  )
  credentials.push({ role: "O'qituvchi", name: teacherName, group: null, username: teacherUsername, password: DEMO_PASSWORD })

  // 2b) Fan biriktirish — o'qituvchining "Mavzular" bo'limida fan chiqishi uchun
  await pool.query(
    `INSERT INTO lms_teacher_subjects (user_id, subject_name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE subject_name = VALUES(subject_name)`,
    [TEACHER_ID, DEMO_SUBJECT]
  )
  for (const gid of GROUP_IDS) {
    await pool.query(
      `INSERT INTO lms_teacher_schedule (teacher_user_id, group_id, subject_name, week_day, start_time, end_time, room)
       VALUES (?, ?, ?, 'Dushanba', '09:00', '10:20', '101-xona')`,
      [TEACHER_ID, gid, DEMO_SUBJECT]
    )
  }

  // 3) Talabalar (guruh boshiga STUDENTS_PER_GROUP[g] tadan)
  let studentId = 9601
  const students: { id: number; name: string; username: string; groupId: number }[] = []
  for (let g = 0; g < GROUP_IDS.length; g++) {
    for (let s = 1; s <= STUDENTS_PER_GROUP[g]; s++) {
      const name = `Demo Talaba ${g + 1}-${s}`
      const username = `demo_student${g + 1}_${s}`
      await pool.query(
        `INSERT INTO hemis_users (hemis_id, role, username, full_name)
         VALUES (?, 'student', ?, ?)
         ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`,
        [String(studentId), name, name]
      )
      await pool.query(
        `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role) VALUES (?, ?, ?, 'student')`,
        [studentId, name, GROUP_IDS[g]]
      )
      await pool.query(
        `INSERT INTO lms_demo_accounts (username, password_hash, role, hemis_id, full_name, group_id, teacher_group_ids)
         VALUES (?, ?, 'student', ?, ?, ?, NULL)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), full_name = VALUES(full_name), group_id = VALUES(group_id)`,
        [username, passwordHash, studentId, name, GROUP_IDS[g]]
      )
      credentials.push({ role: "Talaba", name, group: GROUP_NAMES[g], username, password: DEMO_PASSWORD })
      students.push({ id: studentId, name, username, groupId: GROUP_IDS[g] })
      studentId++
    }
  }
  console.log("\n=== DEMO HISOBLAR TAYYOR — login sahifasida shu login/parol bilan kiring ===\n")
  console.table(credentials)
  console.log(`\nHammasi uchun bitta parol: ${DEMO_PASSWORD}`)
  console.log(`Hisoblar: ${teacherUsername}, ${HERO_STUDENT_USERNAME}`)
  console.log("O'chirish uchun: npx ts-node scripts/seed-demo.ts --remove\n")

  await pool.end()
}

if (process.argv.includes("--remove")) {
  remove().catch(err => { console.error(err); process.exit(1) })
} else {
  seed().catch(err => { console.error(err); process.exit(1) })
}
