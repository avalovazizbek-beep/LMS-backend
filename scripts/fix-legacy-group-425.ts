/**
 * BH-M-425 talabalari va o'qituvchilariga ilgari kodda qattiq yozilgan 425
 * guruh ID'si berilardi. HEMIS'da BH-M-425 ning haqiqiy ID'si boshqa, 425 esa
 * begona eski guruh (KTB-118 1, masofaviy emas — uning talabalari LMS'ga
 * kira olmaydi). Shu sabab talaba tokenidan yozilgan quyidagi qatorlar
 * noto'g'ri guruhda qolgan — bu skript ularni haqiqiy ID'ga ko'chiradi.
 *
 * Avval faqat KO'RISH (hech narsa o'zgarmaydi):
 *   npx ts-node -P scripts/tsconfig.json scripts/fix-legacy-group-425.ts
 * Keyin bajarish:
 *   npx ts-node -P scripts/tsconfig.json scripts/fix-legacy-group-425.ts --apply
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"

const apply = process.argv.includes("--apply")
const LEGACY_ID = 425
const GROUP_NAME = "BH-M-425"

// Talaba tokenidagi groupId to'g'ridan-to'g'ri yoziladigan joylar
const TARGETS: { table: string; column: string; dedupe?: boolean }[] = [
  { table: "lms_meeting_users",          column: "group_id" },
  { table: "lms_meeting_attendance",     column: "group_id" },
  { table: "lms_platform_sessions",      column: "group_id" },
  { table: "lms_conversations",          column: "student_group_id" },
  { table: "lms_exam_violations",        column: "group_id" },
  { table: "lms_hemis_task_submissions", column: "group_id" },
  { table: "lms_submissions",            column: "group_id" },
  // O'qituvchi profilidagi BH-M-425 ham 425 ga aylantirilardi
  { table: "lms_teacher_groups",         column: "group_id", dedupe: true },
]

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}

async function main() {
  const legacy = await rows("SELECT id, name FROM lms_groups WHERE id = ?", [LEGACY_ID])
  const real = await rows("SELECT id FROM lms_groups WHERE name = ? AND id <> ?", [GROUP_NAME, LEGACY_ID])
  const dir = await rows(
    "SELECT group_id, COUNT(*) AS n FROM hemis_students_directory WHERE group_name = ? GROUP BY group_id",
    [GROUP_NAME]
  )
  console.log(`lms_groups #${LEGACY_ID}:`, legacy[0]?.name ?? "(yo'q)")
  console.log(`${GROUP_NAME} lms_groups:`, real.map((r) => r.id), "katalog:", dir.map((r) => `${r.group_id} (${r.n} talaba)`))

  const ids = new Set<number>([...real.map((r) => Number(r.id)), ...dir.map((r) => Number(r.group_id))])
  if (ids.size !== 1) {
    console.error(`${GROUP_NAME} uchun bitta aniq ID topilmadi — to'xtatildi`)
    process.exit(1)
  }
  const realId = [...ids][0]
  console.log(`Haqiqiy ID: ${realId}\n`)

  for (const { table, column, dedupe } of TARGETS) {
    if (!(await rows("SHOW TABLES LIKE ?", [table])).length) continue
    const [{ n }] = await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, [LEGACY_ID])
    let line = `${table}.${column}: ${n}`
    if (apply && Number(n) > 0) {
      const [upd] = await pool.query<mysql.ResultSetHeader>(
        `UPDATE ${dedupe ? "IGNORE " : ""}${table} SET ${column} = ? WHERE ${column} = ?`, [realId, LEGACY_ID]
      )
      line += ` → ko'chirildi ${upd.affectedRows}`
      if (dedupe) {
        // PRIMARY KEY to'qnashgan (o'qituvchida ikkala ID ham bor) — eski qator ortiqcha
        const [del] = await pool.query<mysql.ResultSetHeader>(`DELETE FROM ${table} WHERE ${column} = ?`, [LEGACY_ID])
        line += `, takror o'chirildi ${del.affectedRows}`
      }
    }
    console.log(line)
  }
  console.log(apply ? "\nBajarildi." : "\nFaqat ko'rish. Bajarish uchun: --apply")
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
