/**
 * Demo hisoblar va ularning barcha ma'lumotlarini o'chirish (demo endi
 * ishlatilmaydi). Oldingi seed skriptlari (seed-demo, seed-dean-demo,
 * attach-admin-demo) yaratgan narsalar: DEMO-M-101…104 guruhlari, demo
 * o'qituvchi/dekanat/talabalar, ularning mavzu, resurs, test, javob, davomat,
 * baho, meeting, murojaat, Face ID, bildirishnomalari.
 *
 * MUHIM: demo ID'lar (o'qituvchi 9501, talabalar 9601–9604) haqiqiy HEMIS
 * talabalarining ID'lari bilan TO'QNASHADI. Shuning uchun hech narsa faqat
 * talaba ID'si bo'yicha o'chirilmaydi — demo ekanligi quyidagilardan biri
 * bilan aniqlanadi: demo guruh (nomi "DEMO-"), "Demo " bilan boshlanuvchi
 * ism (haqiqiy HEMIS ismlari katta harfda), "Demo fan" yoki xodimlar
 * katalogida yo'q demo xodim ID'si.
 *
 * Avval faqat KO'RISH (hech narsa o'zgarmaydi):
 *   npx ts-node -P scripts/tsconfig.json scripts/remove-demo-data.ts
 * Keyin bajarish:
 *   npx ts-node -P scripts/tsconfig.json scripts/remove-demo-data.ts --apply
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { deleteTeacherContent, removeStoredFile } from "../src/services/teachingStore"

const apply = process.argv.includes("--apply")
// Eski seed skriptlaridagi demo xodimlar (o'qituvchi va dekanat)
const KNOWN_DEMO_EMPLOYEE_IDS = [9501, 2_000_009_502]
const DEMO_NAME = "Demo %"          // LIKE BINARY — katta-kichik harf farqlanadi
const DEMO_TEXT = ["%Demo fan%", "%Demo Talaba%", "%Demo O'qituvchi%", "%Demo Dekanat%", "%DEMO-M-%"]

const inList = (ids: unknown[]) => (ids.length ? ids : [null])  // IN (NULL) — hech narsaga mos kelmaydi

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}

async function tableExists(name: string) {
  return (await rows("SHOW TABLES LIKE ?", [name])).length > 0
}

const report: { step: string; count: number }[] = []

/** Bitta qadam: avval sanaydi, --apply bo'lsa o'chiradi */
async function step(label: string, table: string, where: string, params: unknown[]) {
  if (!(await tableExists(table))) return
  const [{ n }] = await rows(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, params) as { n: number }[]
  report.push({ step: label, count: Number(n) })
  if (apply && Number(n) > 0) await pool.query(`DELETE FROM ${table} WHERE ${where}`, params)
}

async function main() {
  // ── 1. Demo identifikatorlarini aniqlash ──
  const groupRows = await rows("SELECT id, name FROM lms_groups WHERE name LIKE BINARY 'DEMO-%'")
  const groups = new Set<number>(groupRows.map((r) => Number(r.id)))
  const employeeCandidates = new Set<number>(KNOWN_DEMO_EMPLOYEE_IDS)
  const studentIds = new Set<number>()
  const hasAccounts = await tableExists("lms_demo_accounts")
  if (hasAccounts) {
    for (const a of await rows("SELECT * FROM lms_demo_accounts")) {
      if (a.role === "employee") employeeCandidates.add(Number(a.hemis_id))
      else studentIds.add(Number(a.hemis_id))
      const gid = a.group_id == null ? null : Number(a.group_id)
      if (gid != null) {
        const g = await rows("SELECT name FROM lms_groups WHERE id = ?", [gid])
        if (!g.length || String(g[0].name).startsWith("DEMO-")) groups.add(gid)
      }
    }
  }
  // Haqiqiy xodim bilan to'qnashgan ID — u bo'yicha hech narsa o'chirilmaydi
  const realEmployees = await rows(
    "SELECT hemis_id FROM hemis_employees_directory WHERE hemis_id IN (?)", [inList([...employeeCandidates])]
  )
  for (const r of realEmployees) {
    console.warn(`! ${r.hemis_id} — haqiqiy xodim ID'si, u bo'yicha o'chirish o'tkazib yuborildi`)
    employeeCandidates.delete(Number(r.hemis_id))
  }
  const G = inList([...groups])
  const E = inList([...employeeCandidates])
  const S = inList([...studentIds])
  console.log(`Demo guruhlar: ${groupRows.map((r) => `${r.name} (${r.id})`).join(", ") || "yo'q"}`)
  console.log(`Demo xodim ID'lari: ${[...employeeCandidates].join(", ") || "yo'q"}`)
  console.log(`Demo talaba ID'lari (faqat demo belgisi bilan): ${[...studentIds].join(", ") || "yo'q"}`)
  console.log(apply ? "\n— O'CHIRILMOQDA —" : "\n— FAQAT KO'RISH (o'chirish uchun --apply) —")

  // ── 2. Demo guruhlardagi va demo o'qituvchining kontenti (fayllari bilan) ──
  const contentIds = (await rows(
    "SELECT id FROM lms_teacher_content WHERE group_id IN (?) OR teacher_user_id IN (?)", [G, E]
  )).map((r) => Number(r.id))
  report.push({ step: "Mavzu/resurs/test/topshiriq (javoblari, savollari, progress bilan)", count: contentIds.length })
  if (apply && contentIds.length) {
    for (const r of await rows(
      "SELECT relative_path FROM lms_submissions WHERE content_id IN (?) AND relative_path IS NOT NULL", [contentIds]
    )) removeStoredFile(r.relative_path as string)
    for (const id of contentIds) await deleteTeacherContent(id)
  }

  // ── 3. Meetinglar: demo o'qituvchiniki yoki faqat demo guruhlarga ──
  const meetingIds = (await rows(
    `SELECT m.id FROM lms_meetings m
     WHERE m.created_by_user_id IN (?)
        OR (EXISTS (SELECT 1 FROM lms_meeting_groups g WHERE g.meeting_id = m.id AND g.group_id IN (?))
            AND NOT EXISTS (SELECT 1 FROM lms_meeting_groups g WHERE g.meeting_id = m.id AND g.group_id NOT IN (?)))`,
    [E, G, G]
  )).map((r) => Number(r.id))
  report.push({ step: "Onlayn darslar (yozuvlari, davomati bilan)", count: meetingIds.length })
  if (apply && meetingIds.length) {
    for (const r of await rows(
      "SELECT relative_path FROM lms_meeting_recordings WHERE meeting_id IN (?)", [meetingIds]
    )) removeStoredFile(r.relative_path as string)
    for (const t of ["lms_meeting_zoom", "lms_meeting_google_meet"]) {
      if (await tableExists(t)) await pool.query(`DELETE FROM ${t} WHERE meeting_id IN (?)`, [meetingIds])
    }
    await pool.query("DELETE FROM lms_meetings WHERE id IN (?)", [meetingIds])
  }

  // ── 4. Murojaatlar (xabarlar va ilova fayllari bilan) ──
  const convIds = (await rows(
    `SELECT id FROM lms_conversations
     WHERE student_group_id IN (?) OR student_name LIKE BINARY ?
        OR (recipient_type = 'teacher' AND recipient_user_id IN (?))`,
    [G, DEMO_NAME, E]
  )).map((r) => Number(r.id))
  report.push({ step: "Murojaatlar", count: convIds.length })
  if (apply && convIds.length) {
    for (const r of await rows(
      "SELECT attachment_path FROM lms_conversation_messages WHERE conversation_id IN (?) AND attachment_path IS NOT NULL", [convIds]
    )) removeStoredFile(r.attachment_path as string)
    await pool.query("DELETE FROM lms_conversation_messages WHERE conversation_id IN (?)", [convIds])
    await pool.query("DELETE FROM lms_conversations WHERE id IN (?)", [convIds])
  }

  // ── 5. HEMIS topshiriqlariga yuklangan fayllar (demo guruhlar) ──
  if (apply && (await tableExists("lms_hemis_task_submissions"))) {
    for (const r of await rows(
      "SELECT relative_path FROM lms_hemis_task_submissions WHERE group_id IN (?) AND relative_path IS NOT NULL", [G]
    )) removeStoredFile(r.relative_path as string)
  }
  await step("HEMIS topshiriq javoblari", "lms_hemis_task_submissions", "group_id IN (?)", [G])

  // ── 6. Guruh bo'yicha yozuvlar ──
  await step("Davomat", "lms_attendance", "group_id IN (?)", [G])
  await step("Davomatni tahrirlash so'rovlari", "lms_attendance_edit_requests", "group_id IN (?) OR teacher_user_id IN (?)", [G, E])
  await step("Baholar", "lms_grades", "group_id IN (?)", [G])
  await step("ON/YN baholari", "lms_period_grades", "group_id IN (?)", [G])
  await step("O'qituvchi–guruh bog'lanishi", "lms_teacher_groups", "group_id IN (?) OR user_id IN (?)", [G, E])
  await step("Dars jadvali", "lms_teacher_schedule", "group_id IN (?) OR teacher_user_id IN (?)", [G, E])
  await step("O'qituvchi fanlari", "lms_teacher_subjects", "user_id IN (?) OR subject_name = 'Demo fan'", [E])
  await step("Qayta o'qishga yozilganlar", "lms_reedu_enrollments", "original_group_id IN (?)", [G])
  await step("Meeting foydalanuvchilari", "lms_meeting_users", "group_id IN (?) OR full_name LIKE BINARY ?", [G, DEMO_NAME])
  await step("Kirishlar tarixi", "lms_platform_sessions",
    "(role = 'student' AND group_id IN (?)) OR (role = 'employee' AND user_id IN (?)) OR full_name LIKE BINARY ?", [G, E, DEMO_NAME])

  // ── 7. Demo xodim ID'lari bo'yicha (xodimlar katalogida yo'q — to'qnashuv yo'q) ──
  await step("Tashakkurnomalar", "lms_teacher_certificates", "teacher_user_id IN (?)", [E])
  await step("Zoom ulanishlari", "zoom_connections", "teacher_id IN (?)", [E])
  await step("Google Meet ulanishlari", "google_meet_connections", "teacher_id IN (?)", [E])
  await step("Admin/dekan huquqlari", "lms_permissions",
    "hemis_id IN (?) OR full_name LIKE BINARY ?", [inList([...employeeCandidates].map(String)), DEMO_NAME])
  await step("E'lonni yopganlar (xodim)", "lms_announcement_dismissals", "user_role = 'employee' AND user_id IN (?)", [E])

  // ── 8. Ism bo'yicha ("Demo ..." — haqiqiy HEMIS ismlari katta harfda) ──
  await step("E'lonlarga javoblar", "lms_announcement_replies", "full_name LIKE BINARY ?", [DEMO_NAME])
  await step("Face ID shablonlari", "face_registrations",
    "username LIKE BINARY ? OR display_name LIKE BINARY ? OR username LIKE 'demo\\_%'", [DEMO_NAME, DEMO_NAME])
  await step("Face ID arizalari", "face_requests",
    "username LIKE BINARY ? OR username LIKE 'demo\\_%' OR (user_role = 'employee' AND user_id IN (?))", [DEMO_NAME, E])
  await step("HEMIS foydalanuvchi keshi", "hemis_users",
    "full_name LIKE BINARY ? OR username LIKE 'demo\\_%' OR (role = 'employee' AND hemis_id IN (?))",
    [DEMO_NAME, inList([...employeeCandidates].map(String))])

  // ── 9. Bildirishnomalar: demo xodimniki + matnida demo nomlari borlari ──
  const textConds = DEMO_TEXT.map(() => "CONCAT_WS(' ', title, body, link, i18n_params) LIKE BINARY ?").join(" OR ")
  await step("Bildirishnomalar", "lms_notifications",
    `(user_role = 'employee' AND user_id IN (?)) OR ${textConds}`, [E, ...DEMO_TEXT])
  // Demo talaba ID'iga kelgan, lekin matnida demo belgisi yo'q bildirishnomalar
  // o'chirilmaydi — ular shu ID'li haqiqiy talabaniki bo'lishi mumkin.
  void S

  // ── 10. Guruhlar va demo hisoblar jadvali ──
  await step("Demo guruhlar", "lms_groups", "id IN (?)", [G])
  if (hasAccounts) {
    const [{ n }] = await rows("SELECT COUNT(*) AS n FROM lms_demo_accounts") as { n: number }[]
    report.push({ step: "Demo hisoblar (lms_demo_accounts jadvali butunlay)", count: Number(n) })
    if (apply) await pool.query("DROP TABLE lms_demo_accounts")
  }

  console.log("")
  for (const r of report) console.log(`${String(r.count).padStart(6)}  ${r.step}`)
  console.log(apply
    ? "\nTayyor: demo ma'lumotlar o'chirildi."
    : "\nHech narsa o'zgarmadi. O'chirish uchun shu buyruqni --apply bilan qayta ishga tushiring.")
  await pool.end()
}

main().catch(async (err) => {
  console.error("Xato:", err instanceof Error ? err.message : err)
  await pool.end().catch(() => undefined)
  process.exit(1)
})
