/**
 * Sinov guruhi: o'qituvchiga real HEMIS ma'lumotiga tegmaydigan "SINOV-M-101"
 * guruhi va "Sinov fani"ni biriktiradi — oraliq nazorat (test / topshiriq),
 * mustaqil ish va 35 ballik taqsimotni real talabalarsiz sinab ko'rish uchun.
 *
 * O'qituvchini ismi yoki ID'si bilan berish mumkin (ism bo'yicha bitta odam
 * topilsa — o'sha). Avval faqat KO'RISH, keyin --apply bilan bajarish:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --teacher "AVALOV AZIZBEK"
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --teacher "AVALOV AZIZBEK" --apply
 * Sinov talabasi (talaba tomonini ko'rish uchun) — har safar yangi parol
 * chiqaradi, eskisi ishlamay qoladi; kirish: /sinov-login:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --student --apply
 * Maxsus imkoniyatlar (ko'zi ojiz talaba) sinovi uchun 5 savolli tayyor test —
 * sinov talabasi bilan birga; chiqqan havola orqali ochiladi:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --student --demo-test --apply
 * Qaytadan boshlash — guruh, fan, asos mavzular, sinov talabasi (paroli,
 * Face ID) qoladi; o'qituvchi yaratgan hamma narsa (mavzular, test,
 * topshiriq, oraliq, mustaqil ish), talaba ishlari, baholar, davomat o'chadi:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --reset --teacher "AVALOV AZIZBEK" --apply
 * Sinov tugagach — guruh, sinov talabasi va hamma narsani o'chirish:
 *   npx ts-node -P scripts/tsconfig.json scripts/sinov-guruh.ts --remove --apply
 *
 * - Guruh ID 990000102: HEMIS'da uchramaydigan diapazon (Zoom test hisobi
 *   990000101 bilan bir qatorda) — real guruh/talaba bilan to'qnashmaydi.
 * - Nomida "-M-" bor: LMS faqat masofaviy guruhlarni ko'rsatadi.
 * - HEMIS sinxronizatsiyasi o'qituvchining guruhlar ro'yxatini har kirishda
 *   qayta yozadi; guruh o'qituvchida shu guruhdagi mavzulari (kontenti)
 *   orqali ko'rinib turadi — shu sabab ma'ruza va amaliyot uchun bo'sh mavzu
 *   yaratiladi (mustaqil ish Nazoratlar bo'limida, oraliq bilan bir joyda).
 * - Guruhda talaba yo'q: jurnal ustunlari (maksimal ballar) ko'rinadi,
 *   talabalar qatori bo'sh bo'ladi.
 * - Oraliqlar: HEMIS'da bu guruh yo'q, shu sabab backend o'qituvchining
 *   HEMIS nazoratlar ro'yxatiga "1-on" / "2-on" qatorlarini qo'shadi
 *   (services/sinovSandbox.ts) — Imtihonlar ro'yxati → Yangi qo'shish.
 */
import "dotenv/config"
import crypto from "crypto"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { recordPlatformSession } from "../src/services/attendanceStore"
import { replaceQuestions } from "../src/services/examStore"
import {
  addTeacherGroups, createTeacherContent, deleteTeacherContent, listTeacherContent, upsertGroups,
} from "../src/services/teachingStore"
import {
  SINOV_GROUP_ID, SINOV_GROUP_NAME, SINOV_SUBJECT, SINOV_STUDENT_ID, SINOV_STUDENT_LOGIN, SINOV_STUDENT_NAME,
  SINOV_PASSWORD_SETTING,
} from "../src/services/sinovSandbox"

const SINOV_TOPICS = [
  { title: "1-mavzu (sinov)", trainingType: "Ma'ruza" },
  { title: "1-amaliy mashg'ulot (sinov)", trainingType: "Amaliyot" },
]

const apply = process.argv.includes("--apply")
const remove = process.argv.includes("--remove")
const student = process.argv.includes("--student")
const reset = process.argv.includes("--reset")
const demoTest = process.argv.includes("--demo-test")

const DEMO_TEST_TITLE = "Maxsus imkoniyatlar sinov testi"
// Testning egasi: --teacher berilmasa — HEMIS'da uchramaydigan ID (hech kimning kabinetida ko'rinmaydi)
const DEMO_TEST_OWNER = 990000301

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

/** Skript backend qayta ishga tushishidan oldin ham ishlasin: yangi ustunlar
    (db.ts initDatabase bilan bir xil) hali qo'shilmagan bo'lsa — qo'shadi */
async function ensureGradeColumns() {
  for (const sql of [
    "ALTER TABLE lms_teacher_content ADD COLUMN grade_points INT NULL DEFAULT NULL",
    "ALTER TABLE lms_teacher_content ADD COLUMN grade_part VARCHAR(20) NULL DEFAULT NULL",
  ]) {
    try {
      await pool.query(sql)
    } catch (err) {
      if ((err as { code?: string }).code !== "ER_DUP_FIELDNAME") throw err
    }
  }
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

  await ensureGradeColumns()
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

/** Sinov talabasi: yangi tasodifiy parol, bazaga faqat sha256 xeshi */
async function createStudent() {
  console.log(`\nSinov talabasi: login ${SINOV_STUDENT_LOGIN}, ${SINOV_STUDENT_NAME}, guruh ${SINOV_GROUP_NAME}`)
  if (!apply) {
    console.log("KO'RISH rejimi — parol yaratilmadi. Bajarish uchun oxiriga --apply qo'shing.")
    return
  }
  // O'xshash belgilarsiz (0/O, 1/l/I) 12 ta belgi
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const password = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("")
  const hash = crypto.createHash("sha256").update(password, "utf8").digest("hex")
  await upsertGroups([{ id: SINOV_GROUP_ID, name: SINOV_GROUP_NAME }])
  await pool.query(
    "INSERT INTO lms_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    [SINOV_PASSWORD_SETTING, hash]
  )
  // Kirmasidan oldin ham o'qituvchi jurnalida ko'rinsin
  await recordPlatformSession(SINOV_STUDENT_ID, SINOV_STUDENT_NAME, SINOV_GROUP_ID, "student")
  console.log(`\n  Kirish sahifasi: https://lms.sies.uz/sinov-login\n  Login:  ${SINOV_STUDENT_LOGIN}\n  Parol:  ${password}\n`)
  console.log("Parol faqat hozir ko'rinadi (bazada xeshi). Yangisi kerak bo'lsa — shu buyruqni qayta ishga tushiring.")
}

/** Guruhni bo'shatish: faqat asos mavzular (guruh va fan ko'rinib turishi
    uchun) qoladi — o'qituvchi yaratgan qolgan hamma narsa o'chadi */
async function resetContent() {
  const items = await listTeacherContent({ groupId: SINOV_GROUP_ID })
  const isAnchor = (c: (typeof items)[number]) =>
    c.type === "mavzu" && c.kind === "topic" && c.subjectName === SINOV_SUBJECT &&
    SINOV_TOPICS.some((tp) => tp.title === c.title && tp.trainingType === c.trainingType)
  const doomed = items.filter((c) => !isAnchor(c))
  const subs = await rows("SELECT COUNT(*) AS n FROM lms_submissions WHERE content_id IN (?)", [doomed.length ? doomed.map((i) => i.id) : [null]])
  console.log(`${SINOV_GROUP_NAME}: ${doomed.length} ta o'chiriladigan kontent (mavzu, test, topshiriq, oraliq, mustaqil ish), ${subs[0].n} ta topshirilgan ish`)
  console.log(`Qoladi: guruh, "${SINOV_SUBJECT}", ${items.length - doomed.length} ta asos mavzu, sinov talabasi (paroli va Face ID)`)
  if (!apply) {
    console.log("\nKO'RISH rejimi — hech narsa o'zgarmadi. Bajarish uchun oxiriga --apply qo'shing.")
    return
  }
  for (const item of doomed) await deleteTeacherContent(item.id)
  await pool.query("DELETE FROM lms_period_grades WHERE group_id = ?", [SINOV_GROUP_ID])
  await pool.query("DELETE FROM lms_attendance WHERE group_id = ?", [SINOV_GROUP_ID])
  await pool.query("DELETE FROM lms_notifications WHERE user_role = 'student' AND user_id = ?", [SINOV_STUDENT_ID])
  console.log("\nTozalandi — oraliq, mustaqil ish va topshiriqlarni qaytadan yaratishingiz mumkin.")
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
  await pool.query("DELETE FROM lms_attendance WHERE group_id = ?", [SINOV_GROUP_ID])
  await pool.query("DELETE FROM lms_teacher_groups WHERE group_id = ?", [SINOV_GROUP_ID])
  await pool.query("DELETE FROM lms_groups WHERE id = ?", [SINOV_GROUP_ID])
  // Sinov talabasi: kirish huquqi, kirish tarixi, Face ID, bildirishnomalari
  await pool.query("DELETE FROM lms_settings WHERE key_name = ?", [SINOV_PASSWORD_SETTING])
  await pool.query("DELETE FROM lms_platform_sessions WHERE user_id = ? AND role = 'student'", [SINOV_STUDENT_ID])
  await pool.query("DELETE FROM face_registrations WHERE username = ?", [SINOV_STUDENT_LOGIN])
  await pool.query("DELETE FROM face_requests WHERE username = ?", [SINOV_STUDENT_LOGIN])
  await pool.query("DELETE FROM lms_notifications WHERE user_role = 'student' AND user_id = ?", [SINOV_STUDENT_ID])
  console.log("\nSinov guruhi, sinov talabasi va hamma narsa o'chirildi.")
}

/** Sinov guruhida 5 savolli test (10 daqiqa) — bor bo'lsa qayta yaratilmaydi */
async function createDemoTest(teacherId: number | null) {
  const existing = (await listTeacherContent({ groupId: SINOV_GROUP_ID })).find((c) => c.type === "exam" && c.title === DEMO_TEST_TITLE)
  console.log(`\nSinov testi: "${DEMO_TEST_TITLE}" — ${existing ? `bor (#${existing.id})` : "yaratiladi"}, 5 savol, 10 daqiqa`)
  if (!apply) {
    console.log("KO'RISH rejimi — hech narsa o'zgarmadi. Bajarish uchun oxiriga --apply qo'shing.")
    return
  }
  await upsertGroups([{ id: SINOV_GROUP_ID, name: SINOV_GROUP_NAME }])
  const content = existing ?? await createTeacherContent({
    type: "exam", teacherUserId: teacherId ?? DEMO_TEST_OWNER, groupId: SINOV_GROUP_ID, subjectName: SINOV_SUBJECT,
    title: DEMO_TEST_TITLE, trainingType: "Amaliyot",
    availableFrom: new Date(Date.now() - 3600_000).toISOString(),
    deadline: new Date(Date.now() + 30 * 86400_000).toISOString(),
    maxScore: 100, attemptsCount: 20, durationMinutes: 10,
  })
  await replaceQuestions(content.id, [
    { questionText: "O'zbekiston poytaxti qaysi shahar?", options: ["Samarqand", "Toshkent", "Buxoro", "Xiva"], correctIndex: 1, points: 1 },
    { questionText: "2 + 2 nechaga teng?", options: ["3", "4", "5", "22"], correctIndex: 1, points: 1 },
    { questionText: "Bir yilda necha oy bor?", options: ["10", "11", "12", "13"], correctIndex: 2, points: 1 },
    { questionText: "LMS qisqartmasi nimani anglatadi?", options: ["Ta'limni boshqarish tizimi", "Kutubxona tizimi", "Elektron pochta", "Brauzer"], correctIndex: 0, points: 1 },
    { questionText: "Ekran o'quvchi dasturga misol qaysi?", options: ["Excel", "NVDA", "Paint", "Zoom"], correctIndex: 1, points: 1 },
  ])
  console.log(`\n  Test havolasi (sinov talabasi bilan kirgandan keyin): https://lms.sies.uz/imtihonlar/${content.id}\n`)
}

async function main() {
  if (remove) {
    await removeAll()
    return
  }
  if (reset) await resetContent()
  let teacherId: number | null = null
  if (argValue("--teacher") || (!student && !demoTest)) {
    teacherId = await resolveTeacher()
    if (teacherId !== null) await attach(teacherId)
  }
  if (demoTest) await createDemoTest(teacherId)
  if (student) await createStudent()
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
