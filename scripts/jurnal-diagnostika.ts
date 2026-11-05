/**
 * FAQAT O'QIYDI — hech narsa o'zgartirmaydi. "Baholadim, lekin Natijalarda
 * chiqmayapti" murojaatlari uchun: guruh (+ fan) bo'yicha har bir baholanadigan
 * test/topshiriq Natijalar jurnalining qaysi ustuniga tushishini yoki nega
 * tushmasligini ko'rsatadi.
 *
 *   npx ts-node -P scripts/tsconfig.json scripts/jurnal-diagnostika.ts --group BI-M-126
 *   npx ts-node -P scripts/tsconfig.json scripts/jurnal-diagnostika.ts --group BI-M-126 --subject "amaliy matematika"
 *
 * --subject — fan nomining bir qismi (katta-kichik harf farqsiz); berilmasa guruhdagi barcha fanlar.
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { listTeacherContent, topicTrainingType, type TeacherContentRecord } from "../src/services/teachingStore"
import { miColumns, pickPeriodExams, MUSTAQIL_CONTROL } from "../src/services/periodGrades"

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}

const isMustaqilTopic = (t: string | null) => !!t && /mustaqil/i.test(t)

function verdict(c: TeacherContentRecord, topicType: string | null, slots: Map<number, string>, mi: Map<number, string>): string {
  if (slots.has(c.id)) return `✓ jurnalda: ${slots.get(c.id)}`
  if (mi.has(c.id)) return `✓ jurnalda: ${mi.get(c.id)}${c.isActive ? "" : " (nofaol — baholash yakunlangan / o'chirilgan)"}`
  if (c.controlType === MUSTAQIL_CONTROL) {
    if (c.topicKey) return "✗ mavzu ichidagi mustaqil ish — hisobga kirmaydi"
    return "✗ mustaqil ishga ball qo'yilmagan (grade_points bo'sh) — hisobga kirmaydi"
  }
  if (c.controlType === "oraliq") return "✗ oraliq, lekin ON1/ON2 o'rni boshqa oraliqda (faoli ustun)"
  if (c.controlType === "yakuniy") return "✗ yakuniy, lekin YN boshqa yakuniyda"
  if (!c.topicKey) return `✗ mavzusiz, nazorat turi: ${c.controlType ?? "yo'q"} — jurnalga kirmaydi`
  if (c.type === "exam" && c.questionCount === 0) return "✗ savolsiz test — hisobga kirmaydi"
  if (topicType === "Amaliyot") return "✓ jurnalda: amaliy mavzu → JN"
  if (topicType === "Ma'ruza") return "✗ MA'RUZA mavzusidagi ish — faqat keyingi mavzuni ochadi, ball bermaydi"
  if (isMustaqilTopic(topicType)) return "✗ Fan resurslaridagi ESKI \"Mustaqil ish\" mavzusi — hisobga kirmaydi (Nazoratlarda qayta yaratish kerak)"
  return `✗ mavzu turi noma'lum (${topicType ?? "yo'q"}) — hisobga kirmaydi`
}

async function main() {
  const groupName = arg("group")
  const subjectPart = arg("subject")?.toLowerCase() ?? null
  if (!groupName) {
    console.error("Foydalanish: --group BI-M-126 [--subject \"amaliy matematika\"]")
    process.exit(1)
  }
  const groups = await rows("SELECT id, name FROM lms_groups WHERE name = ?", [groupName])
  if (!groups.length) {
    console.error(`Guruh topilmadi: ${groupName}`)
    process.exit(1)
  }

  // O'qituvchi ismi — oxirgi kirish sessiyasidan
  const names = new Map<number, string>()
  for (const r of await rows(
    `SELECT s.user_id, s.full_name FROM lms_platform_sessions s
     JOIN (SELECT user_id, MAX(id) AS id FROM lms_platform_sessions WHERE role <> 'student' GROUP BY user_id) l ON l.id = s.id`
  )) names.set(Number(r.user_id), String(r.full_name ?? ""))

  for (const g of groups) {
    const groupId = Number(g.id)
    const all = await listTeacherContent({ groupId })
    const subjects = [...new Set(all.map((c) => c.subjectName))]
      .filter((s) => !subjectPart || s.toLowerCase().includes(subjectPart))
    if (!subjects.length) console.log(`${g.name} #${groupId}: mos fan topilmadi. Bor fanlar: ${[...new Set(all.map((c) => c.subjectName))].join(", ")}`)

    for (const subject of subjects) {
      const content = all.filter((c) => c.subjectName.toLowerCase() === subject.toLowerCase())
      const byTopic = new Map<string, TeacherContentRecord[]>()
      for (const c of content) {
        if (!c.topicKey) continue
        if (!byTopic.has(c.topicKey)) byTopic.set(c.topicKey, [])
        byTopic.get(c.topicKey)!.push(c)
      }
      const exams = pickPeriodExams(content)
      const slots = new Map<number, string>()
      for (const k of ["ON1", "ON2", "YN"] as const) if (exams[k]) slots.set(exams[k]!.id, k)
      const mi = new Map(miColumns(content).map((col) => [col.id, `${col.part} ${col.label} /${col.points}`]))

      const graded = content.filter((c) => c.type === "exam" || c.type === "assignment")
      const ids = graded.map((c) => c.id)
      const stats = new Map<number, { n: number; g: number }>()
      if (ids.length) {
        for (const r of await rows(
          `SELECT content_id, COUNT(*) n, SUM(grade IS NOT NULL) g FROM lms_submissions WHERE content_id IN (?) GROUP BY content_id`, [ids]
        )) stats.set(Number(r.content_id), { n: Number(r.n), g: Number(r.g) })
      }

      console.log(`\n══ ${g.name} #${groupId} — ${subject} ══`)
      const sorted = graded.sort((a, b) => (a.topicKey ?? "").localeCompare(b.topicKey ?? "", undefined, { numeric: true }) || a.id - b.id)
      for (const c of sorted) {
        const topicType = c.topicKey ? topicTrainingType(byTopic.get(c.topicKey) ?? []) : null
        const marker = c.topicKey ? byTopic.get(c.topicKey)?.find((x) => x.type === "mavzu" && x.kind === "topic") : undefined
        const s = stats.get(c.id) ?? { n: 0, g: 0 }
        console.log(
          `#${c.id} [${c.type}${c.controlType ? `/${c.controlType}` : ""}${c.isActive ? "" : ", NOFAOL"}] "${c.title}"` +
          `${marker ? ` — mavzu: "${marker.title}" (${topicType ?? "turi yo'q"})` : ""}` +
          ` | ball: ${c.gradePoints ?? "—"} ${c.gradePart ?? ""} | maks: ${c.maxScore ?? "—"}` +
          ` | o'qituvchi: ${names.get(c.teacherUserId) || c.teacherUserId}` +
          ` | topshirgan ${s.n}, baholangan ${s.g}`,
        )
        console.log(`    ${verdict(c, topicType, slots, mi)}`)
      }
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => pool.end())
