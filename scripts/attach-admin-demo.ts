/**
 * Demo guruh + talaba + fanni HAQIQIY (HEMIS orqali kiradigan) admin/xodim
 * hisobiga biriktiradi — alohida demo_teacher login kerak bo'lmasin, admin
 * o'z haqiqiy hisobi bilan kirib sinasin. `hemis_employees_directory`dan
 * ism bo'yicha qidiradi (HEMIS full sync orqali oldindan to'ldirilgan).
 *
 * Ishga tushirish (standart qidiruv — "Avalov Azizbek"):
 *   npx ts-node scripts/attach-admin-demo.ts
 * Boshqa ism bilan qidirish:
 *   npx ts-node scripts/attach-admin-demo.ts "Boshqa Ism"
 *
 * O'chirish (shu skript yaratgan biriktirishlarni olib tashlash):
 *   npx ts-node scripts/attach-admin-demo.ts --remove [ism]
 */
import "dotenv/config"
import bcrypt from "bcryptjs"
import type mysql from "mysql2/promise"
import { pool, initDatabase } from "../src/services/db"

const GROUP_IDS = [9901, 9902]
const GROUP_NAMES = ["DEMO-101", "DEMO-102"]
const STUDENT_IDS = [9601, 9602]
const DEMO_SUBJECT = "Demo fan"
const DEMO_PASSWORD = "demo12345"

const args = process.argv.slice(2).filter(a => a !== "--remove")
const isRemove = process.argv.includes("--remove")
const searchTerm = args[0] || "Avalov Azizbek"

async function findEmployee(term: string) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT hemis_id, full_name, login, position FROM hemis_employees_directory WHERE full_name LIKE ? AND is_active = 1",
    [`%${term}%`]
  )
  return rows
}

async function main() {
  await initDatabase()

  const matches = await findEmployee(searchTerm)
  if (matches.length === 0) {
    console.error(`"${searchTerm}" bo'yicha xodim topilmadi. hemis_employees_directory'da to'g'ri yozilishini tekshiring yoki boshqa qidiruv so'zi bering.`)
    await pool.end()
    process.exit(1)
  }
  if (matches.length > 1) {
    console.error(`"${searchTerm}" bo'yicha ${matches.length} ta xodim topildi — aniqroq qidiruv so'zi bering:`)
    console.table(matches.map(m => ({ hemis_id: m.hemis_id, full_name: m.full_name, login: m.login, position: m.position })))
    await pool.end()
    process.exit(1)
  }

  const employee = matches[0]
  const teacherId = Number(employee.hemis_id)
  console.log(`Topildi: ${employee.full_name} (hemis_id=${teacherId}, login=${employee.login})`)

  if (isRemove) {
    await pool.query("DELETE FROM lms_teacher_groups WHERE user_id = ? AND group_id IN (?, ?)", [teacherId, ...GROUP_IDS])
    await pool.query("DELETE FROM lms_teacher_subjects WHERE user_id = ? AND subject_name = ?", [teacherId, DEMO_SUBJECT])
    await pool.query("DELETE FROM lms_teacher_schedule WHERE teacher_user_id = ? AND group_id IN (?, ?)", [teacherId, ...GROUP_IDS])
    await pool.query("DELETE FROM lms_demo_accounts WHERE hemis_id IN (?, ?)", STUDENT_IDS)
    await pool.query("DELETE FROM hemis_users WHERE CAST(hemis_id AS UNSIGNED) IN (?, ?)", STUDENT_IDS)
    await pool.query("DELETE FROM lms_platform_sessions WHERE user_id IN (?, ?)", STUDENT_IDS)
    const groupPlaceholders = GROUP_IDS.map(() => "?").join(", ")
    await pool.query(`DELETE FROM lms_groups WHERE id IN (${groupPlaceholders})`, GROUP_IDS)
    console.log(`${employee.full_name} uchun demo guruh/fan biriktirilishi va demo talabalar o'chirildi.`)
    await pool.end()
    return
  }

  // 1) Guruhlar
  for (let i = 0; i < GROUP_IDS.length; i++) {
    await pool.query(
      "INSERT INTO lms_groups (id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)",
      [GROUP_IDS[i], GROUP_NAMES[i]]
    )
  }

  // 2) Guruh + fanni haqiqiy xodimga biriktirish
  for (const gid of GROUP_IDS) {
    await pool.query("INSERT IGNORE INTO lms_teacher_groups (user_id, group_id) VALUES (?, ?)", [teacherId, gid])
  }
  await pool.query(
    `INSERT INTO lms_teacher_subjects (user_id, subject_name) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE subject_name = VALUES(subject_name)`,
    [teacherId, DEMO_SUBJECT]
  )
  for (const gid of GROUP_IDS) {
    await pool.query(
      `INSERT INTO lms_teacher_schedule (teacher_user_id, group_id, subject_name, week_day, start_time, end_time, room)
       VALUES (?, ?, ?, 'Dushanba', '09:00', '10:20', '101-xona')`,
      [teacherId, gid, DEMO_SUBJECT]
    )
  }

  // 3) Demo talabalar (login+parol bilan kiradigan, har guruhda bittadan) —
  // talaba tomonidagi ko'rinishni sinash uchun hali ham kerak.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10)
  const students: { name: string; username: string; group: string; password: string }[] = []
  for (let g = 0; g < GROUP_IDS.length; g++) {
    const studentId = STUDENT_IDS[g]
    const name = `Demo Talaba ${g + 1}-1`
    const username = `demo_student${g + 1}_1`
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
    students.push({ name, username, group: GROUP_NAMES[g], password: DEMO_PASSWORD })
  }

  console.log(`\n=== ${employee.full_name} (login: ${employee.login}) endi DEMO-101 va DEMO-102 guruhlariga "${DEMO_SUBJECT}" fanidan biriktirildi ===`)
  console.log("O'zingizning odatdagi HEMIS orqali kirish tugmasi bilan kiring — Fan resurslari/Mavzular bo'limida shu guruhlar va fan chiqadi.\n")
  console.log("Talaba tomonini sinash uchun demo talaba hisoblari:")
  console.table(students)
  console.log(`\nO'chirish uchun: npx ts-node scripts/attach-admin-demo.ts --remove "${searchTerm}"\n`)

  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
