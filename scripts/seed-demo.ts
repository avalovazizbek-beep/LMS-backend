/**
 * Demo (test) hisoblar yaratish — HEMIS orqali kirmasdan, LOGIN + PAROL bilan
 * haqiqiy login sahifasi orqali sinash uchun.
 *
 * Yaratadi: 1 ta demo o'qituvchi, 2 ta guruh, har guruhda 3 tadan (jami 6 ta) talaba.
 * Login sahifasidagi "HEMIS Login" / "Parol" maydonlariga shu ma'lumotlarni kiritib
 * kirish mumkin — backend ularni HEMIS'ga umuman murojaat qilmasdan tanийди.
 *
 * Ishga tushirish:
 *   npx ts-node scripts/seed-demo.ts
 *
 * O'chirish (keyinroq demolarni olib tashlash uchun):
 *   npx ts-node scripts/seed-demo.ts --remove
 */
import "dotenv/config"
import bcrypt from "bcryptjs"
import { pool, initDatabase } from "../src/services/db"

const TEACHER_ID = 9501
const GROUP_IDS = [9901, 9902]
const GROUP_NAMES = ["DEMO-101", "DEMO-102"]
const STUDENTS_PER_GROUP = 3
const DEMO_PASSWORD = "demo12345"

async function remove() {
  await initDatabase()
  await pool.query("DELETE FROM lms_demo_accounts WHERE hemis_id = ? OR hemis_id BETWEEN 9601 AND 9699", [TEACHER_ID])
  await pool.query("DELETE FROM hemis_users WHERE hemis_id = ? OR CAST(hemis_id AS UNSIGNED) BETWEEN 9601 AND 9699", [String(TEACHER_ID)])
  await pool.query("DELETE FROM lms_platform_sessions WHERE user_id = ? OR user_id BETWEEN 9601 AND 9699", [TEACHER_ID])
  await pool.query("DELETE FROM lms_teacher_groups WHERE user_id = ?", [TEACHER_ID])
  await pool.query("DELETE FROM lms_groups WHERE id IN (?, ?)", GROUP_IDS)
  console.log("Demo hisoblar o'chirildi.")
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

  // 3) Talabalar (har guruhda 3 tadan)
  let studentId = 9601
  for (let g = 0; g < GROUP_IDS.length; g++) {
    for (let s = 1; s <= STUDENTS_PER_GROUP; s++) {
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
      studentId++
    }
  }

  console.log("\n=== DEMO HISOBLAR TAYYOR — login sahifasida shu login/parol bilan kiring ===\n")
  console.table(credentials)
  console.log(`\nHammasi uchun bitta parol: ${DEMO_PASSWORD}`)
  console.log("O'chirish uchun: npx ts-node scripts/seed-demo.ts --remove\n")

  await pool.end()
}

if (process.argv.includes("--remove")) {
  remove().catch(err => { console.error(err); process.exit(1) })
} else {
  seed().catch(err => { console.error(err); process.exit(1) })
}
