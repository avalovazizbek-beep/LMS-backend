/**
 * FAQAT O'QIYDI — hech narsa o'zgartirmaydi. "Muddati o'tgan ishni talaba qanday
 * yukladi?" murojaatlari uchun: talabaning so'nggi kunlardagi topshiriqlari,
 * har birining muddati, va kech yuklashga nima yo'l bergani (muddat hali ochiq /
 * mavzu qayta ochilgan / shaxsiy ruxsat / muddat o'zgartirilgan).
 *
 *   npx ts-node -P scripts/tsconfig.json scripts/kech-yuklash-diagnostika.ts --student "SATTAROV SHAXRIYOR"
 *   npx ts-node -P scripts/tsconfig.json scripts/kech-yuklash-diagnostika.ts --student "SATTAROV SHAXRIYOR" --days 7
 *
 * --student — F.I.Sh. ning bir qismi; --days — necha kun orqaga (standart 2).
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { getTeacherContent, findTopicMarker, contentStatus } from "../src/services/teachingStore"

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}

const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleString("ru-RU", { timeZone: "Asia/Tashkent" }) : "—")

async function main() {
  const student = arg("student")
  const days = Number(arg("days") ?? 2)
  if (!student) {
    console.error('Foydalanish: --student "FAMILIYA ISM" [--days 2]')
    process.exit(1)
  }
  const like = `%${student.trim().split(/\s+/).join("%")}%`

  const dir = await rows(
    "SELECT hemis_id, full_name, group_id, group_name, is_active FROM hemis_students_directory WHERE full_name LIKE ?", [like]
  )
  console.log("HEMIS ro'yxatida:")
  for (const d of dir) console.log(`  #${d.hemis_id} ${d.full_name} — ${d.group_name} (#${d.group_id})${d.is_active ? "" : " [nofaol]"}`)
  if (!dir.length) console.log("  topilmadi (ism bo'yicha topshiriqlardan qidiriladi)")

  const subs = await rows(
    `SELECT s.id, s.content_id, s.student_user_id, s.student_full_name, s.group_id, s.original_name,
            s.submitted_at, s.grade, s.graded_at, s.attempts_used, g.name AS group_name
     FROM lms_submissions s LEFT JOIN lms_groups g ON g.id = s.group_id
     WHERE s.student_full_name LIKE ? AND s.submitted_at >= NOW() - INTERVAL ? DAY
     ORDER BY s.submitted_at DESC`,
    [like, days]
  )
  console.log(`\nSo'nggi ${days} kundagi topshiriqlar: ${subs.length} ta`)

  const teacherNames = new Map<number, string>()
  for (const r of await rows("SELECT hemis_id, full_name FROM hemis_employees_directory")) {
    teacherNames.set(Number(r.hemis_id), String(r.full_name ?? ""))
  }

  for (const s of subs) {
    const c = await getTeacherContent(Number(s.content_id))
    if (!c) continue
    const marker = c.topicKey ? await findTopicMarker(c.topicKey) : null
    const submittedAt = new Date(s.submitted_at)
    const deadline = c.deadline ? new Date(c.deadline) : null
    const late = !!deadline && submittedAt.getTime() > deadline.getTime()

    console.log(`\n══ #${c.id} [${c.type}${c.controlType ? `/${c.controlType}` : ""}${c.isActive ? "" : ", NOFAOL"}] "${c.title}" ══`)
    console.log(`  fan: ${c.subjectName} | guruh: ${s.group_name ?? s.group_id} | o'qituvchi: ${teacherNames.get(c.teacherUserId) || c.teacherUserId}`)
    console.log(`  talaba: ${s.student_full_name} (#${s.student_user_id}) | fayl: ${s.original_name ?? "—"} | urinish: ${s.attempts_used}`)
    console.log(`  yuklangan: ${fmt(submittedAt)} | baho: ${s.grade ?? "—"}${s.graded_at ? ` (${fmt(s.graded_at)})` : ""}`)
    console.log(`  ochilgan: ${fmt(c.availableFrom)} | HOZIRGI muddat: ${fmt(c.deadline)} | hozirgi holat: ${contentStatus(new Date(), c.availableFrom, c.deadline)}`)
    console.log(`  yozuv oxirgi o'zgargan: ${fmt((await rows("SELECT updated_at FROM lms_teacher_content WHERE id = ?", [c.id]))[0]?.updated_at)}`)
    if (marker) {
      console.log(`  mavzu: "${marker.title}" | mavzu muddati: ${fmt(marker.deadline)} | qayta ochilgan: ${marker.isReopened ? `HA (${marker.reopenedBy ?? "?"}, ${fmt(marker.reopenedAt)})` : "yo'q"}`)
    }

    const grants = await rows(
      "SELECT status, granted_by, reason, granted_at, used_at, revoked_at FROM lms_exam_retake_grants WHERE content_id = ? AND student_user_id = ? ORDER BY id",
      [c.id, s.student_user_id]
    )
    for (const g of grants) {
      console.log(`  shaxsiy ruxsat: ${g.status} | bergan: ${g.granted_by ?? "?"} | ${fmt(g.granted_at)} | ishlatilgan: ${fmt(g.used_at)}${g.reason ? ` | sabab: ${g.reason}` : ""}`)
    }
    if (!grants.length) console.log("  shaxsiy ruxsat: yo'q")

    const targets = [String(c.id), ...(c.topicKey ? [c.topicKey] : [])]
    const audit = await rows(
      `SELECT actor_name, actor_role, action, target, detail, created_at FROM lms_audit_log
       WHERE target IN (?) AND created_at >= NOW() - INTERVAL 30 DAY ORDER BY id`,
      [targets]
    )
    for (const a of audit) {
      const detail = a.detail ? (typeof a.detail === "string" ? a.detail : JSON.stringify(a.detail)) : ""
      console.log(`  audit: ${fmt(a.created_at)} | ${a.actor_name ?? "?"} (${a.actor_role ?? "?"}) | ${a.action} | ${detail.slice(0, 200)}`)
    }
    if (!audit.length) console.log("  audit: bu ish/mavzu bo'yicha 30 kunda yozuv yo'q")

    let verdict: string
    if (!deadline) verdict = "muddat qo'yilmagan — istalgan vaqtda yuklash mumkin"
    else if (!late) verdict = "muddat ichida yuklangan (hozirgi muddatga ko'ra) — muddat keyin uzaytirilgan bo'lishi mumkin, auditga qarang"
    else if (grants.some((g) => g.used_at)) verdict = "MUDDATDAN KEYIN — shaxsiy ruxsat orqali"
    else if (marker?.isReopened) verdict = "MUDDATDAN KEYIN — mavzu butun guruhga qayta ochilgan"
    else verdict = "MUDDATDAN KEYIN, ruxsat ham qayta ochish ham ko'rinmaydi — muddat yuklagandan so'ng qisqartirilgan/o'zgartirilgan yoki mavzu keyin yopilgan (auditga qarang)"
    console.log(`  XULOSA: ${verdict}`)
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => pool.end())
