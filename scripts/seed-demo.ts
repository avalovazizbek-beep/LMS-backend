/**
 * Demo (test) hisoblar yaratish — HEMIS orqali kirmasdan, LOGIN + PAROL bilan
 * haqiqiy login sahifasi orqali sinash uchun. Video/taqdimot uchun barcha
 * bo'limlarda (jadval, resurslar, davomat, baholar, imtihonlar, meeting,
 * Face ID) real ma'lumot ko'rinishi uchun boy tarzda to'ldiriladi.
 *
 * Faqat 2 ta hisob yaratiladi — `demo_teacher` va `demo_student1_1` — video
 * uchun ortiqcha hisoblar admin panelini (foydalanuvchilar ro'yxati va h.k.)
 * chalkashtirmasligi uchun. Ikkalasi ham eng boy ma'lumot bilan: Face ID
 * ro'yxatdan o'tgan, qayta urinish ruxsati, barcha materiallar tugatilgan,
 * meetingda ishtirok etgan.
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
import { grantRetake } from "../src/services/retakeStore"

const TEACHER_ID = 9501
const GROUP_IDS = [9901]
const GROUP_NAMES = ["DEMO-101"]
// Faqat 1 ta talaba — demo_student1_1 (hero hisob)
const STUDENTS_PER_GROUP = [1]
// remove() uchun — bu skriptning oldingi versiyalari 9902 (DEMO-102)ni ham
// yaratgan edi; shu ro'yxat har doim TO'LIQ tozalash uchun, GROUP_IDS'dan
// mustaqil ravishda saqlanadi (GROUP_IDS kichraytirilsa ham eski qoldiqlar tozalanadi).
const ALL_KNOWN_GROUP_IDS = [9901, 9902]
const DEMO_PASSWORD = "demo12345"
const DEMO_SUBJECT = "Demo fan"
const PERIOD_GRADE_TYPES = ["ON1"] as const
// "Hero" hisob — video uchun eng boy ma'lumot shu talabaga beriladi
const HERO_STUDENT_USERNAME = "demo_student1_1"

function daysAgo(n: number, hour = 9, minute = 0): Date {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  d.setDate(d.getDate() - n)
  return d
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}
function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length - 1)]
}

async function remove() {
  await initDatabase()
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
  // lms_meetings o'chirilishi lms_meeting_groups va lms_meeting_attendance'ni
  // FK ON DELETE CASCADE orqali avtomatik tozalaydi
  await pool.query("DELETE FROM lms_meetings WHERE created_by_user_id = ?", [TEACHER_ID])
  // lms_teacher_content o'chirilishi lms_submissions, lms_content_progress,
  // lms_exam_retake_grants'ni FK ON DELETE CASCADE orqali avtomatik tozalaydi
  await pool.query("DELETE FROM lms_teacher_content WHERE teacher_user_id = ?", [TEACHER_ID])
  await pool.query(`DELETE FROM lms_groups WHERE id IN (${groupPlaceholders})`, ALL_KNOWN_GROUP_IDS)
  console.log("Demo hisoblar o'chirildi.")
  await pool.end()
}

interface ContentRef { id: number; type: string; kind: string | null }

async function upsertContent(
  uuidSeed: string,
  gid: number,
  topicKey: string,
  type: string,
  kind: string | null,
  title: string,
  availableFrom: Date,
  maxScore: number | null
): Promise<ContentRef> {
  const uuid = `${uuidSeed}-0000-4000-8000-${String(gid).padStart(12, "0")}`
  await pool.query(
    `INSERT INTO lms_teacher_content
      (uuid, type, teacher_user_id, group_id, subject_name, topic_key, title, kind, available_from, max_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title), available_from = VALUES(available_from), max_score = VALUES(max_score), kind = VALUES(kind)`,
    [uuid, type, TEACHER_ID, gid, DEMO_SUBJECT, topicKey, title, kind, availableFrom, maxScore]
  )
  const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT id, type, kind FROM lms_teacher_content WHERE uuid = ?", [uuid])
  return { id: Number(row.id), type: row.type, kind: row.kind }
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
  const heroStudent = students.find(s => s.username === HERO_STUDENT_USERNAME)!

  // 3b) Kontent kutubxonasi — har guruh uchun 3 ta mavzu, har biri turli xil
  // kontent turi bilan (video/audio/taqdimot/qo'llanma/test/amaliy) — admin
  // panelidagi "Kontent turlari" taqsimotida haqiqiy xilma-xillik ko'rinishi
  // uchun (kind/type qiymatlari admin.ts'ning teacher-stats klassifikatsiyasiga mos).
  const now = new Date()
  const contentByGroup = new Map<number, { videoId: number; audioId: number; theoryId: number; qollanmaId: number; examId: number; assignmentId: number }>()
  for (const gid of GROUP_IDS) {
    await upsertContent("10000000", gid, `demo-topic-${gid}-1`, "mavzu", null, "1-mavzu: Kirish", daysAgo(20), null)
    const video = await upsertContent("11000000", gid, `demo-topic-${gid}-1`, "lesson", "video_lesson", "1-mavzu — Video dars", daysAgo(20), null)
    const audio = await upsertContent("12000000", gid, `demo-topic-${gid}-1`, "lesson", "audio", "1-mavzu — Audio dars", daysAgo(20), null)

    await upsertContent("20000000", gid, `demo-topic-${gid}-2`, "mavzu", null, "2-mavzu: Nazariy asoslar", daysAgo(14), null)
    const theory = await upsertContent("21000000", gid, `demo-topic-${gid}-2`, "lesson", "theory", "2-mavzu — Taqdimot", daysAgo(14), null)
    const qollanma = await upsertContent("22000000", gid, `demo-topic-${gid}-2`, "lesson", "qollanma", "2-mavzu — Qo'llanma", daysAgo(14), null)

    await upsertContent("30000000", gid, `demo-topic-${gid}-3`, "mavzu", null, "3-mavzu: Yakuniy nazorat", daysAgo(7), null)
    const exam = await upsertContent("31000000", gid, `demo-topic-${gid}-3`, "exam", null, "3-mavzu imtihoni", daysAgo(7), 100)
    const assignment = await upsertContent("32000000", gid, `demo-topic-${gid}-3`, "assignment", null, "3-mavzu amaliy topshiriq", daysAgo(7), 100)

    contentByGroup.set(gid, {
      videoId: video.id, audioId: audio.id, theoryId: theory.id, qollanmaId: qollanma.id,
      examId: exam.id, assignmentId: assignment.id,
    })
  }

  // 4) Har bir talaba uchun — baholar, davomat, kontent progressi
  const today = new Date().toISOString().slice(0, 10)
  for (const student of students) {
    const isHero = student.username === HERO_STUDENT_USERNAME
    const content = contentByGroup.get(student.groupId)!

    // 4a) Imtihon + amaliy topshiriq baholari
    const examGrade = isHero ? 96 : randomInt(55, 99)
    await pool.query(
      `INSERT INTO lms_submissions (content_id, student_user_id, student_full_name, group_id, grade, graded_at, graded_by_user_id)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE grade = VALUES(grade), graded_at = VALUES(graded_at)`,
      [content.examId, student.id, student.name, student.groupId, examGrade, TEACHER_ID]
    )
    const assignmentGrade = isHero ? 98 : randomInt(60, 100)
    await pool.query(
      `INSERT INTO lms_submissions (content_id, student_user_id, student_full_name, group_id, grade, graded_at, graded_by_user_id)
       VALUES (?, ?, ?, ?, ?, NOW(), ?)
       ON DUPLICATE KEY UPDATE grade = VALUES(grade), graded_at = VALUES(graded_at)`,
      [content.assignmentId, student.id, student.name, student.groupId, assignmentGrade, TEACHER_ID]
    )

    for (const gradeType of PERIOD_GRADE_TYPES) {
      const grade = isHero ? 92 : randomInt(60, 94)
      await pool.query(
        `INSERT INTO lms_period_grades (group_id, subject_name, student_user_id, grade_type, grade, teacher_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE grade = VALUES(grade)`,
        [student.groupId, DEMO_SUBJECT, student.id, gradeType, grade, TEACHER_ID]
      )
    }
    const lessonGrade = isHero ? 5 : randomInt(3, 5)
    await pool.query(
      `INSERT INTO lms_grades (group_id, subject_name, lesson_date, student_user_id, student_full_name, grade, marked_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE grade = VALUES(grade)`,
      [student.groupId, DEMO_SUBJECT, today, student.id, student.name, lessonGrade, TEACHER_ID]
    )

    // 4b) Davomat — so'nggi 2 hafta, aksariyati "keldi"
    for (let d = 13; d >= 0; d -= 2) {
      const status = isHero
        ? (d === 5 ? "excused" : "present")
        : pick(["present", "present", "present", "present", "late", "absent", "excused"] as const)
      await pool.query(
        `INSERT INTO lms_attendance (group_id, subject_name, lesson_date, student_user_id, student_full_name, status, marked_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status = VALUES(status)`,
        [student.groupId, DEMO_SUBJECT, daysAgo(d).toISOString().slice(0, 10), student.id, student.name, status, TEACHER_ID]
      )
    }

    // 4c) Kontent progressi — video/audio/taqdimot/qo'llanma
    const lessonIds = [content.videoId, content.audioId, content.theoryId, content.qollanmaId]
    for (const contentId of lessonIds) {
      const completed = isHero || Math.random() < 0.75
      await pool.query(
        `INSERT INTO lms_content_progress (content_id, student_user_id, max_position_seconds, duration_seconds, completed, completed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE max_position_seconds = VALUES(max_position_seconds), completed = VALUES(completed), completed_at = VALUES(completed_at)`,
        [contentId, student.id, completed ? 600 : randomInt(60, 400), 600, completed ? 1 : 0, completed ? new Date() : null]
      )
    }
  }

  // 4d) Hero talabaga qayta urinish ruxsati — "Qayta o'qish" oqimi uchun namuna
  const heroContent = contentByGroup.get(heroStudent.groupId)!
  await grantRetake(heroContent.examId, heroStudent.id, teacherName, "Demo namunasi — qayta urinish ruxsati")

  // 4e) Hero talaba uchun Face ID ro'yxatdan o'tgan holat (soxta descriptor)
  const fakeDescriptor = Array.from({ length: 128 }, () => Math.round((Math.random() * 0.4 - 0.2) * 1e6) / 1e6)
  await pool.query(
    `INSERT INTO face_registrations (username, display_name, descriptors)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), descriptors = VALUES(descriptors)`,
    [heroStudent.name, heroStudent.name, JSON.stringify([fakeDescriptor])]
  )

  // 5) Meeting — har guruh uchun bitta tugagan onlayn dars, ishtirokchilar bilan
  // (skript qayta ishga tushirilsa meeting ikkilanmasligi uchun avval bor-yo'qligi tekshiriladi)
  const meetingTitle = `${DEMO_SUBJECT} — onlayn dars`
  for (const gid of GROUP_IDS) {
    const start = daysAgo(3, 10, 0)
    const end = daysAgo(3, 11, 0)

    const [[existing]] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT m.id FROM lms_meetings m
       JOIN lms_meeting_groups mg ON mg.meeting_id = m.id
       WHERE m.created_by_user_id = ? AND m.title = ? AND mg.group_id = ? LIMIT 1`,
      [TEACHER_ID, meetingTitle, gid]
    )
    let meetingId: number
    if (existing) {
      meetingId = Number(existing.id)
    } else {
      const [result] = await pool.query<mysql.ResultSetHeader>(
        `INSERT INTO lms_meetings (title, description, subject_name, created_by_user_id, start_time, end_time, status, settings_json)
         VALUES (?, ?, ?, ?, ?, ?, 'ended', ?)`,
        [meetingTitle, "1-mavzu bo'yicha onlayn ma'ruza", DEMO_SUBJECT, TEACHER_ID, start, end, "{}"]
      )
      meetingId = result.insertId
      await pool.query("INSERT INTO lms_meeting_groups (meeting_id, group_id) VALUES (?, ?)", [meetingId, gid])
    }

    const groupStudents = students.filter(s => s.groupId === gid)
    for (const student of groupStudents) {
      const isHero = student.username === HERO_STUDENT_USERNAME
      if (!isHero && Math.random() > 0.8) continue // aksariyati ishtirok etadi, hammasi emas
      await pool.query(
        `INSERT INTO lms_meeting_attendance (meeting_id, user_id, group_id, full_name, face_visible_seconds, synced_to_main_backend)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE face_visible_seconds = VALUES(face_visible_seconds)`,
        [meetingId, student.id, gid, student.name, isHero ? 3400 : randomInt(1800, 3500)]
      )
    }
  }

  console.log("\n=== DEMO HISOBLAR TAYYOR — login sahifasida shu login/parol bilan kiring ===\n")
  console.table(credentials)
  console.log(`\nHammasi uchun bitta parol: ${DEMO_PASSWORD}`)
  console.log(`"Hero" (video uchun asosiy) hisoblar: ${teacherUsername}, ${HERO_STUDENT_USERNAME}`)
  console.log("O'chirish uchun: npx ts-node scripts/seed-demo.ts --remove\n")

  await pool.end()
}

if (process.argv.includes("--remove")) {
  remove().catch(err => { console.error(err); process.exit(1) })
} else {
  seed().catch(err => { console.error(err); process.exit(1) })
}
