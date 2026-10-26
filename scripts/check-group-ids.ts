/**
 * FAQAT O'QIYDI — hech narsa o'zgartirmaydi. BH-M-425 kabi "talaba tokenidagi
 * guruh ID'si o'qituvchi kontentidagi ID bilan mos emas" holatlari boshqa
 * guruhlarda ham bormi — barcha talabalar va guruhlar bo'yicha tekshiradi.
 *
 *   npx ts-node -P scripts/tsconfig.json scripts/check-group-ids.ts
 *
 * 1. Kirgan har bir talaba: tokenidagi guruh (backend'ning o'z
 *    withFixedGroupId'idan o'tkazilgan) HEMIS katalogidagi guruhi bilan bir xilmi.
 * 2. Kontent yuklangan, lekin bitta ham faol talabasi yo'q guruhlar
 *    (o'qituvchi noto'g'ri ID'ga yuklagan bo'lsa shu yerda chiqadi).
 * 3. Masofaviy guruhlar: talabalar soni va ularga ko'rinadigan mavzular soni.
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { withFixedGroupId, type AuthUser } from "../src/middleware/auth"

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}

async function main() {
  const groupNames = new Map<number, string>()
  for (const g of await rows("SELECT id, name FROM lms_groups")) groupNames.set(Number(g.id), String(g.name))
  const gname = (id: number | null) => (id == null ? "(yo'q)" : `${groupNames.get(id) ?? "?"} #${id}`)

  // Har bir guruhda talabaga ko'rinadigan mavzular (Fan resurslari topic_key bo'yicha sanaydi)
  const topicsByGroup = new Map<number, number>()
  for (const r of await rows(
    "SELECT group_id, COUNT(DISTINCT topic_key) AS n FROM lms_teacher_content WHERE topic_key IS NOT NULL GROUP BY group_id"
  )) topicsByGroup.set(Number(r.group_id), Number(r.n))

  console.log("EMPLOYEE_GROUP_IDS (.env):", process.env.EMPLOYEE_GROUP_IDS?.trim() || "(o'rnatilmagan — yaxshi)")

  // ── 1. Kirgan talabalar: token guruhi ↔ katalog guruhi ──
  const sessions = await rows(
    `SELECT s.user_id, s.full_name, s.group_id AS token_group, d.group_id AS dir_group, d.is_active
     FROM lms_platform_sessions s
     JOIN (SELECT user_id, MAX(id) AS id FROM lms_platform_sessions WHERE role = 'student' GROUP BY user_id) last
       ON last.id = s.id
     LEFT JOIN hemis_students_directory d ON d.hemis_id = s.user_id`
  )
  let ok = 0, notInDir = 0
  const mismatch = new Map<string, { n: number; lostTopics: number; names: string[] }>()
  for (const s of sessions) {
    if (s.dir_group == null) { notInDir++; continue }
    const user: AuthUser = { role: "student", id: Number(s.user_id), groupId: s.token_group }
    await withFixedGroupId(user)
    const effective = user.groupId == null ? null : Number(user.groupId)
    const real = Number(s.dir_group)
    if (effective === real) { ok++; continue }
    const key = `${gname(effective)} → ${gname(real)}`
    const m = mismatch.get(key) ?? { n: 0, lostTopics: topicsByGroup.get(real) ?? 0, names: [] }
    m.n++
    if (m.names.length < 3) m.names.push(String(s.full_name))
    mismatch.set(key, m)
  }
  console.log(`\n1) Kirgan talabalar: ${sessions.length} | to'g'ri: ${ok} | katalogda yo'q: ${notInDir} | NOMOS: ${sessions.length - ok - notInDir}`)
  for (const [key, m] of mismatch) {
    console.log(`   token ${key}: ${m.n} talaba, haqiqiy guruhda ${m.lostTopics} mavzu — masalan ${m.names.join(", ")}`)
  }

  // ── 2. Kontent bor, lekin faol talabasi yo'q guruhlar ──
  const orphan = await rows(
    `SELECT c.group_id, COUNT(*) AS items, GROUP_CONCAT(DISTINCT c.subject_name SEPARATOR ' | ') AS subjects,
            GROUP_CONCAT(DISTINCT COALESCE(e.full_name, c.teacher_user_id) SEPARATOR ' | ') AS teachers
     FROM lms_teacher_content c
     LEFT JOIN hemis_employees_directory e ON e.hemis_id = c.teacher_user_id
     WHERE c.group_id NOT IN (SELECT DISTINCT group_id FROM hemis_students_directory WHERE is_active = 1 AND group_id IS NOT NULL)
     GROUP BY c.group_id`
  )
  console.log(`\n2) Kontent bor, lekin faol talabasi yo'q guruhlar: ${orphan.length}`)
  for (const o of orphan) {
    console.log(`   ${gname(Number(o.group_id))}: ${o.items} ta yozuv — ${o.subjects} — ${o.teachers}`)
  }

  // ── 3. Masofaviy guruhlar ──
  const groups = await rows(
    `SELECT group_id, MAX(group_name) AS name, COUNT(*) AS students
     FROM hemis_students_directory
     WHERE is_active = 1 AND education_form_code = '16' AND group_id IS NOT NULL
     GROUP BY group_id ORDER BY name`
  )
  const empty = groups.filter((g) => !topicsByGroup.get(Number(g.group_id)))
  console.log(`\n3) Masofaviy guruhlar: ${groups.length} | mavzusi bor: ${groups.length - empty.length} | hali bitta ham mavzu yo'q: ${empty.length}`)
  for (const g of groups) {
    console.log(`   ${String(g.name).padEnd(14)} #${String(g.group_id).padEnd(6)} talaba ${String(g.students).padStart(3)}  mavzu ${topicsByGroup.get(Number(g.group_id)) ?? 0}`)
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
