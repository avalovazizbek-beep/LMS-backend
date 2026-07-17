/**
 * Demo (test) hisoblar yaratish — HEMIS orqali kirmasdan, lokal/serverda
 * LMS'ni sinash uchun. Haqiqiy HEMIS login talab qilinmaydi.
 *
 * Yaratadi: 1 ta demo o'qituvchi, 2 ta guruh, har guruhda 3 tadan (jami 6 ta) talaba.
 * Har biri uchun to'g'ridan-to'g'ri ishlatsa bo'ladigan JWT token chiqaradi.
 *
 * Ishga tushirish:
 *   npx ts-node scripts/seed-demo.ts
 * (yoki: npm run build && node dist/scripts/seed-demo.js — build qilingandan keyin)
 */
import jwt from "jsonwebtoken"
import { pool, initDatabase } from "../src/services/db"

const JWT_SECRET = process.env.JWT_SECRET || "secret"

const TEACHER_ID = 9501
const GROUP_IDS = [9901, 9902]
const GROUP_NAMES = ["DEMO-101", "DEMO-102"]
const STUDENTS_PER_GROUP = 3

function signStudentToken(id: number, fullName: string, groupId: number) {
  return jwt.sign(
    {
      id, userId: id,
      hemisToken: "demo-token",
      role: "student",
      username: fullName,
      fullName,
      groupId,
      studentAuthMode: "password",
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  )
}

function signEmployeeToken(id: number, fullName: string, teacherGroupIds: number[]) {
  return jwt.sign(
    {
      id, userId: id,
      hemisToken: "demo-token",
      role: "employee",
      username: fullName,
      fullName,
      isEmployee: true,
      employeeHemisBase: "https://demo.local",
      employeeProfilePath: "/v1/account/me",
      employeeAuthMode: "password",
      teacherGroupIds,
      employeeType: "O'qituvchi",
    },
    JWT_SECRET,
    { expiresIn: "30d" }
  )
}

async function main() {
  await initDatabase()

  // 1) Guruhlar
  for (let i = 0; i < GROUP_IDS.length; i++) {
    await pool.query(
      "INSERT INTO lms_groups (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)",
      [GROUP_IDS[i], GROUP_NAMES[i]]
    )
  }

  // 2) O'qituvchi
  const teacherName = "Demo O'qituvchi"
  await pool.query(
    `INSERT INTO hemis_users (hemis_id, role, username, full_name, teacher_user_id)
     VALUES (?, 'employee', ?, ?, ?)
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), teacher_user_id = VALUES(teacher_user_id)`,
    [String(TEACHER_ID), teacherName, teacherName, TEACHER_ID]
  )
  await pool.query(
    `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role)
     VALUES (?, ?, NULL, 'employee')`,
    [TEACHER_ID, teacherName]
  )
  for (const gid of GROUP_IDS) {
    await pool.query(
      "INSERT IGNORE INTO lms_teacher_groups (user_id, group_id) VALUES (?, ?)",
      [TEACHER_ID, gid]
    )
  }
  const teacherToken = signEmployeeToken(TEACHER_ID, teacherName, GROUP_IDS)

  // 3) Talabalar (har guruhda 3 tadan)
  const studentTokens: { id: number; name: string; group: string; token: string }[] = []
  let studentId = 9601
  for (let g = 0; g < GROUP_IDS.length; g++) {
    for (let s = 1; s <= STUDENTS_PER_GROUP; s++) {
      const name = `Demo Talaba ${g + 1}-${s}`
      await pool.query(
        `INSERT INTO hemis_users (hemis_id, role, username, full_name)
         VALUES (?, 'student', ?, ?)
         ON DUPLICATE KEY UPDATE full_name = VALUES(full_name)`,
        [String(studentId), name, name]
      )
      await pool.query(
        `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role)
         VALUES (?, ?, ?, 'student')`,
        [studentId, name, GROUP_IDS[g]]
      )
      studentTokens.push({ id: studentId, name, group: GROUP_NAMES[g], token: signStudentToken(studentId, name, GROUP_IDS[g]) })
      studentId++
    }
  }

  console.log("\n=== DEMO HISOBLAR TAYYOR ===\n")
  console.log(`O'QITUVCHI: ${teacherName} (ID: ${TEACHER_ID})`)
  console.log(`Token:\n${teacherToken}\n`)
  for (const st of studentTokens) {
    console.log(`TALABA: ${st.name} (ID: ${st.id}, Guruh: ${st.group})`)
    console.log(`Token:\n${st.token}\n`)
  }
  console.log("=== Brauzerda ishlatish ===")
  console.log(`Saytni oching, F12 (DevTools) -> Console'ga shuni yozing (misol o'qituvchi uchun):\n`)
  console.log(`sessionStorage.setItem('lms_token', 'TOKEN_BU_YERGA'); sessionStorage.setItem('lms_role', 'employee'); location.reload();`)
  console.log(`\nTalaba uchun 'lms_role' o'rniga 'student' yozing.\n`)

  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
