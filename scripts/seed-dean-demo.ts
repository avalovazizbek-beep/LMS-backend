/**
 * Dekanat (dean) demo hisobi — HEMIS'siz, login sahifasidagi "Demo bilan
 * kirish" orqali LOGIN + PAROL bilan kirib, dekan admin panelda nimani
 * ko'rishini sinash uchun. Hisob xodim (employee) sifatida kiradi va
 * lms_permissions'da 'dean' roliga ega — huquqlari Boshqaruv → Ruxsatlar
 * sahifasidagi "Dekan" ustunidan olinadi (sukut bo'yicha faqat Ko'rish).
 *
 * MUHIM: dekan HAQIQIY talaba/xodim ma'lumotlarini ko'radi (demo guruhlar
 * emas) — shu sabab parol seed-demo.ts'dagidek umumiy "demo12345" emas,
 * har ishga tushirishda tasodifiy yangisi yaratiladi (yoki --password bilan).
 *
 * Ishga tushirish:
 *   npx ts-node scripts/seed-dean-demo.ts
 *   npx ts-node scripts/seed-dean-demo.ts --password "OzingizningParolingiz"
 *
 * O'chirish:
 *   npx ts-node scripts/seed-dean-demo.ts --remove
 */
import "dotenv/config"
import crypto from "crypto"
import bcrypt from "bcryptjs"
import type mysql from "mysql2/promise"
import { pool, initDatabase } from "../src/services/db"

// Huquq hemis_id'ga bog'langan (getUserAdminRole) — haqiqiy HEMIS xodimining
// ID'si bilan to'qnashsa, o'sha xodim dekan bo'lib qolardi. Shu sabab ID
// HEMIS ID'lari oralig'idan ancha tashqarida (INT chegarasi ichida).
const DEAN_ID = 2_000_009_502
const DEAN_USERNAME = "demo_dekanat"
const DEAN_NAME = "Demo Dekanat"

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function remove() {
  await initDatabase()
  await pool.query("DELETE FROM lms_demo_accounts WHERE username = ? OR hemis_id = ?", [DEAN_USERNAME, DEAN_ID])
  await pool.query("DELETE FROM lms_permissions WHERE hemis_id = ?", [String(DEAN_ID)])
  await pool.query("DELETE FROM hemis_users WHERE hemis_id = ?", [String(DEAN_ID)])
  await pool.query("DELETE FROM lms_notifications WHERE user_role = 'employee' AND user_id = ?", [DEAN_ID])
  await pool.query("DELETE FROM lms_platform_sessions WHERE user_id = ?", [DEAN_ID])
  console.log(`${DEAN_USERNAME} demo hisobi va dekan huquqi o'chirildi.`)
  await pool.end()
}

async function seed() {
  await initDatabase()

  // Ehtiyot chorasi: shu ID'da bizniki bo'lmagan haqiqiy foydalanuvchi bo'lsa
  // — unga dekan huquqi berib qo'ymaslik uchun to'xtaymiz.
  const [clash] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT 'hemis_users' AS src, username FROM hemis_users WHERE hemis_id = ? AND (username IS NULL OR username <> ?)
     UNION ALL
     SELECT 'hemis_employees_directory', login FROM hemis_employees_directory WHERE hemis_id = ?
     UNION ALL
     SELECT 'hemis_students_directory', login FROM hemis_students_directory WHERE hemis_id = ?`,
    [String(DEAN_ID), DEAN_USERNAME, DEAN_ID, DEAN_ID]
  )
  if (clash.length) {
    console.error(`hemis_id=${DEAN_ID} allaqachon haqiqiy foydalanuvchiga tegishli — hech narsa o'zgartirilmadi:`)
    console.table(clash)
    await pool.end()
    process.exit(1)
  }

  const password = argValue("--password") || crypto.randomBytes(9).toString("base64url")
  const passwordHash = await bcrypt.hash(password, 10)

  await pool.query(
    `INSERT INTO hemis_users (hemis_id, role, username, full_name)
     VALUES (?, 'employee', ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), username = VALUES(username), full_name = VALUES(full_name)`,
    [String(DEAN_ID), DEAN_USERNAME, DEAN_NAME]
  )
  await pool.query(
    `INSERT INTO lms_demo_accounts (username, password_hash, role, hemis_id, full_name, group_id, teacher_group_ids)
     VALUES (?, ?, 'employee', ?, ?, NULL, ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role), hemis_id = VALUES(hemis_id),
       full_name = VALUES(full_name), group_id = NULL, teacher_group_ids = VALUES(teacher_group_ids)`,
    [DEAN_USERNAME, passwordHash, DEAN_ID, DEAN_NAME, JSON.stringify([])]
  )
  // hemis_role = 'employee' — getUserAdminRole huquqni faqat xodim hisobiga beradi
  await pool.query(
    `INSERT INTO lms_permissions (hemis_id, full_name, hemis_role, lms_role, granted_by, note)
     VALUES (?, ?, 'employee', 'dean', 'seed-dean-demo', 'Demo dekanat hisobi (scripts/seed-dean-demo.ts)')
     ON DUPLICATE KEY UPDATE full_name = VALUES(full_name), hemis_role = VALUES(hemis_role), lms_role = VALUES(lms_role),
       granted_by = VALUES(granted_by), note = VALUES(note), updated_at = NOW()`,
    [String(DEAN_ID), DEAN_NAME]
  )

  console.log("\n=== DEKANAT DEMO HISOBI TAYYOR ===\n")
  console.log("Login sahifasi → \"Demo bilan kirish\":")
  console.log(`  Login:  ${DEAN_USERNAME}`)
  console.log(`  Parol:  ${password}`)
  console.log("\nKirgach chap menyudagi \"Admin panel\" — dekan huquqlari Boshqaruv → Ruxsatlar → Dekan ustunidan.")
  console.log("O'chirish uchun: npx ts-node scripts/seed-dean-demo.ts --remove\n")

  await pool.end()
}

if (process.argv.includes("--remove")) {
  remove().catch(err => { console.error(err); process.exit(1) })
} else {
  seed().catch(err => { console.error(err); process.exit(1) })
}
