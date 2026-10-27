/**
 * Sinov guruhi: o'qituvchiga real HEMIS ma'lumotiga tegmaydigan "SINOV-M-101"
 * guruhi va "Sinov fani"ni biriktiradi — oraliq nazorat (test / topshiriq),
 * mustaqil ish va 35 ballik taqsimotni real talabalarsiz sinab ko'rish uchun.
 *
 * O'qituvchini ismi yoki ID'si bilan berish mumkin (ism bo'yicha bitta odam
 * topilsa — o'sha). Avval faqat KO'RISH, keyin --apply bilan bajarish:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --teacher "AVALOV AZIZBEK"
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --teacher "AVALOV AZIZBEK" --apply
 * Sinov tugagach — guruh va undagi hamma narsani o'chirish:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --remove --apply
 *
 * - Guruh ID 990000102: HEMIS'da uchramaydigan diapazon (Zoom test hisobi
 *   990000101 bilan bir qatorda) — real guruh/talaba bilan to'qnashmaydi.
 * - Nomida "-M-" bor: LMS faqat masofaviy guruhlarni ko'rsatadi.
 * - HEMIS sinxronizatsiyasi o'qituvchining guruhlar ro'yxatini har kirishda
 *   qayta yozadi; guruh o'qituvchida shu guruhdagi mavzulari (kontenti)
 *   orqali ko'rinib turadi — shu sabab uchta bo'sh mavzu yaratiladi.
 * - Guruhda talaba yo'q: jurnal ustunlari (maksimal ballar) ko'rinadi,
 *   talabalar qatori bo'sh bo'ladi.
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import {
  addTeacherGroups, createTeacherContent, deleteTeacherContent, listTeacherContent, upsertGroups,
} from "../src/services/teachingStore"

const SINOV_GROUP_ID = 990000102
const SINOV_GROUP_NAME = "SINOV-M-101 (sinov guruhi)"
const SINOV_SUBJECT = "Sinov fani"
const SINOV_TOPICS = [
  { title: "1-mavzu (sinov)", trainingType: "Ma'ruza" },
  { title: "1-amaliy mashg'ulot (sinov)", trainingType: "Amaliyot" },
  { title: "1-mustaqil ish (sinov)", trainingType: "Mustaqil ish" },
]

const apply = process.argv.includes("--apply")
const remove = process.argv.includes("--remove")

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null
}

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}

/** Ism bo'yicha o'qituvchi ID'lari. Asosiy manba — kirish tarixi: unda
    aynan backend teacherUserId() bergan ID yoziladi (kontent shu ID bilan
    saqlanadi). */
async function findTeachers(text: string) {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const like = words.map(() => "full_name LIKE ?").join(" AND ")
  const params = words.map((w) => `%${w}%`)
  const sessions = await rows(
    `SELECT user_id AS id, MAX(full_name) AS full_name, MAX(login_at) AS last_login, COUNT(*) AS n
     FROM lms_platform_sessions WHERE role = 'employee' AND ${like}
     GROUP BY user_id ORDER BY last_login DESC`,
    params
  )
  const users = await rows(
    `SELECT teacher_user_id AS id, full_name FROM hemis_users WHERE teacher_user_id IS NOT NULL AND ${like}`,
    params
  )
  return { sessions, users }
}

async function resolveTeacher(): Promise<number | null> {
  const raw = argValue("--teacher")
  if (!raw) {
    console.log('O\'qituvchini bering: --teacher "AVALOV AZIZBEK" yoki --teacher <ID>')
    return null
  }
  if (/^\d+$/.test(raw)) return Number(raw)

  const { sessions, users } = await findTeachers(raw)
  console.log(`"${raw}" bo'yicha:`)
  for (const s of sessions) console.log(`  kirish tarixi: ID ${s.id} — ${s.full_name} (oxirgi kirish ${new Date(s.last_login).toLocaleString()}, ${s.n} marta)`)
  for (const u of users) console.log(`  hemis_users:   ID ${u.id} — ${u.full_name}`)
  const ids = [...new Set([...sessions, ...users].map((r) => Number(r.id)))]
  if (ids.length === 1) return ids[0]
  console.log(ids.length
    ? "\nBir nechta ID topildi — keraklisini --teacher <ID> bilan bering."
    : "\nTopilmadi. Avval LMS'ga o'qituvchi sifatida bir marta kiring yoki --teacher <ID> bering.")
  return null
}

async function attach(teacherId: number) {
  const existing = await listTeacherContent({ teacherUserId: teacherId, groupId: SINOV_GROUP_ID, subjectName: SINOV_SUBJECT, type: "mavzu" })
  const missing = SINOV_TOPICS.filter((tp) =>
    !existing.some((c) => c.kind === "topic" && c.title === tp.title && c.trainingType === tp.trainingType))

  console.log(`\nO'qituvchi ID ${teacherId} ← ${SINOV_GROUP_NAME} (#${SINOV_GROUP_ID}), fan "${SINOV_SUBJECT}"`)
  console.log(missing.length
    ? `Yaratiladigan mavzular: ${missing.map((m) => `${m.title} [${m.trainingType}]`).join(", ")}`
    : "Mavzular allaqachon bor.")
  if (!apply) {
    console.log("\nKO'RISH rejimi — hech narsa o'zgarmadi. Bajarish uchun oxiriga --apply qo'shing.")
    return
  }

  await upsertGroups([{ id: SINOV_GROUP_ID, name: SINOV_GROUP_NAME }])
  await addTeacherGroups(teacherId, [SINOV_GROUP_ID])
  for (const [i, tp] of missing.entries()) {
    await createTeacherContent({
      type: "mavzu", kind: "topic", teacherUserId: teacherId, groupId: SINOV_GROUP_ID,
      subjectName: SINOV_SUBJECT, topicKey: `${SINOV_SUBJECT}__${SINOV_GROUP_ID}__${Date.now()}${i}`,
      title: tp.title, trainingType: tp.trainingType, availableFrom: new Date().toISOString(),
    })
  }
  console.log("\nTayyor. LMS'dan chiqib qayta kiring: guruh — SINOV-M-101, fan — Sinov fani.")
}

async function removeAll() {
  const items = await listTeacherContent({ groupId: SINOV_GROUP_ID })
  const subs = await rows("SELECT COUNT(*) AS n FROM lms_submissions WHERE content_id IN (?)", [items.length ? items.map((i) => i.id) : [null]])
  console.log(`${SINOV_GROUP_NAME}: ${items.length} ta kontent, ${subs[0].n} ta topshirilgan ish`)
  if (!apply) {
    console.log("\nKO'RISH rejimi — hech narsa o'zgarmadi. O'chirish uchun oxiriga --apply qo'shing.")
    return
  }
  for (const item of items) await deleteTeacherContent(item.id)
  await pool.query("DELETE FROM lms_period_grades WHERE group_id = ?", [SINOV_GROUP_ID])
  await pool.query("DELETE FROM lms_teacher_groups WHERE group_id = ?", [SINOV_GROUP_ID])
  await pool.query("DELETE FROM lms_groups WHERE id = ?", [SINOV_GROUP_ID])
  console.log("\nSinov guruhi va undagi hamma narsa o'chirildi.")
}

async function main() {
  if (remove) await removeAll()
  else {
    const teacherId = await resolveTeacher()
    if (teacherId !== null) await attach(teacherId)
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
