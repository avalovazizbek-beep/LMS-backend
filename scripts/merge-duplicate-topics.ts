/**
 * Takror mavzularni topish va birlashtirish — bir o'qituvchining bir guruhida
 * shu fan + mashg'ulot turi + nomdagi mavzu bir necha marta bo'lsa (eski
 * oqimlardan qolgan: ikki marta bosish, bir nechta guruhga yuklash va h.k.),
 * talaba ikkalasini ko'radi. Har guruhda eng to'liq mavzu qoladi, qolganlardagi
 * yetishmayotgan qismlar unga ko'chiriladi (talaba progressi saqlanadi),
 * ortiqchalari o'chiriladi (mergeDuplicateTopicsInGroup).
 *
 * Avval faqat KO'RISH (hech narsa o'zgarmaydi):
 *   npx ts-node -P scripts/tsconfig.json scripts/merge-duplicate-topics.ts
 * Keyin bajarish:
 *   npx ts-node -P scripts/tsconfig.json scripts/merge-duplicate-topics.ts --apply
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { mergeDuplicateTopicsInGroup } from "../src/services/teachingStore"

async function main() {
  const apply = process.argv.includes("--apply")
  const [rows] = await pool.query<mysql.RowDataPacket[]>(`
    SELECT c.teacher_user_id, c.group_id, g.name AS group_name, c.subject_name,
           NULLIF(TRIM(IFNULL(c.training_type, '')), '') AS training_type,
           MIN(c.title) AS title, COUNT(*) AS copies,
           (SELECT full_name FROM hemis_employees_directory e WHERE e.hemis_id = c.teacher_user_id LIMIT 1) AS teacher
    FROM lms_teacher_content c
    LEFT JOIN lms_groups g ON g.id = c.group_id
    WHERE c.type = 'mavzu' AND c.kind = 'topic'
    GROUP BY c.teacher_user_id, c.group_id, g.name, c.subject_name,
             NULLIF(TRIM(IFNULL(c.training_type, '')), ''), LOWER(TRIM(c.title))
    HAVING COUNT(*) > 1
    ORDER BY teacher, c.subject_name, g.name
  `)

  if (!rows.length) {
    console.log("Takror mavzu yo'q.")
    await pool.end()
    return
  }

  console.table(rows.map((r) => ({
    oqituvchi: r.teacher ?? r.teacher_user_id,
    guruh: r.group_name ?? r.group_id,
    fan: r.subject_name,
    tur: r.training_type ?? "—",
    mavzu: String(r.title).slice(0, 60),
    nusxa: Number(r.copies),
  })))
  console.log(`Jami: ${rows.length} ta guruhda takror mavzu.`)

  if (!apply) {
    console.log("\nBu faqat ko'rish edi. Birlashtirish uchun oxiriga --apply qo'shib qayta ishga tushiring.")
    await pool.end()
    return
  }

  const total = { removedTopics: 0, movedItems: 0, removedItems: 0 }
  for (const r of rows) {
    const res = await mergeDuplicateTopicsInGroup(
      Number(r.teacher_user_id), Number(r.group_id), String(r.subject_name), r.training_type ?? null, String(r.title)
    )
    total.removedTopics += res.removedTopics
    total.movedItems += res.movedItems
    total.removedItems += res.removedItems
  }
  console.log(`\nBajarildi: ${total.removedTopics} ta takror mavzu o'chirildi, ${total.movedItems} ta resurs asosiy mavzuga ko'chirildi, ${total.removedItems} ta ortiqcha resurs o'chirildi.`)
  await pool.end()
}

main().catch((err) => { console.error(err); process.exit(1) })
