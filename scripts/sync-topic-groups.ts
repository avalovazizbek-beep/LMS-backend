/**
 * Bir mavzu (o'qituvchi + fan + mashg'ulot turi + nom) bir nechta guruhda
 * bo'lsa, guruhlar orasidagi farqni to'ldiradi: masalan test faqat bitta
 * guruhda bo'lsa, qolgan guruhlardagi SHU mavzuga ham (savollari bilan)
 * nusxalanadi. Eski kod bir nechta guruhga yuklashda testni ataylab
 * nusxalamas edi — shundan qolgan farqlar.
 *
 * Faqat QO'SHADI: hech narsa o'chirilmaydi/almashtirilmaydi, mavjud
 * test/topshiriqqa tegilmaydi, mavzu yo'q guruhga yangi mavzu yaratilmaydi.
 *
 * Ko'rish:   npx ts-node -P scripts/tsconfig.json scripts/sync-topic-groups.ts
 * Bajarish:  npx ts-node -P scripts/tsconfig.json scripts/sync-topic-groups.ts --apply
 */
import "dotenv/config"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { syncTopicToGroups } from "../src/services/topicSync"

const KIND_LABEL: Record<string, string> = {
  video_lesson: "video", audio: "audio", theory: "taqdimot", qollanma: "qo'llanma",
  youtube: "youtube", meeting: "online dars", uchrashuv: "havola",
}
const slotOf = (r: mysql.RowDataPacket) =>
  r.type === "exam" || r.type === "assignment" ? String(r.type)
    : `${r.type}:${r.kind ?? ""}:${r.kind === "uchrashuv" ? r.meeting_link ?? "" : ""}`
const slotLabel = (slot: string) =>
  slot === "exam" ? "test" : slot === "assignment" ? "topshiriq" : KIND_LABEL[slot.split(":")[1]] ?? slot

async function main() {
  const apply = process.argv.includes("--apply")
  const [markers] = await pool.query<mysql.RowDataPacket[]>(`
    SELECT c.teacher_user_id, c.group_id, g.name AS group_name, c.subject_name, c.title, c.topic_key,
           NULLIF(TRIM(IFNULL(c.training_type, '')), '') AS training_type,
           (SELECT full_name FROM hemis_employees_directory e WHERE e.hemis_id = c.teacher_user_id LIMIT 1) AS teacher
    FROM lms_teacher_content c
    LEFT JOIN lms_groups g ON g.id = c.group_id
    WHERE c.type = 'mavzu' AND c.kind = 'topic' AND c.topic_key IS NOT NULL
  `)

  // Mavzu "shaxsi" bo'yicha guruhlash — bir xil mavzuning har guruhdagi nusxalari
  const topics = new Map<string, mysql.RowDataPacket[]>()
  for (const m of markers) {
    const id = `${m.teacher_user_id}|${m.subject_name}|${m.training_type ?? ""}|${String(m.title).trim().toLowerCase()}`
    if (!topics.has(id)) topics.set(id, [])
    topics.get(id)!.push(m)
  }

  const plan: Array<{ teacherId: number; instances: { groupId: number; topicKey: string; items: number }[] }> = []
  const report: Record<string, string | number>[] = []
  for (const instances of topics.values()) {
    if (new Set(instances.map((i) => i.group_id)).size < 2) continue
    const keys = instances.map((i) => String(i.topic_key))
    const [items] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT topic_key, type, kind, meeting_link FROM lms_teacher_content
       WHERE topic_key IN (?) AND NOT (type = 'mavzu' AND kind = 'topic')`, [keys]
    )
    // Eski xato bilan saqlangan online dars ("#") — yetishmovchilik hisoblanmaydi
    const real = items.filter((it) => !(it.kind === "meeting" && !/^\d+$/.test(String(it.meeting_link ?? ""))))
    const slotsByKey = new Map<string, Set<string>>(keys.map((k) => [k, new Set()]))
    for (const it of real) slotsByKey.get(String(it.topic_key))?.add(slotOf(it))
    const all = new Set(real.map(slotOf))
    let hasGap = false
    for (const inst of instances) {
      const have = slotsByKey.get(String(inst.topic_key))!
      // Test va topshiriq bir-birini istisno qiladi — birining o'rniga ikkinchisi yetishmovchilik emas
      const missing = [...all].filter((s) => !have.has(s) &&
        !((s === "exam" && have.has("assignment")) || (s === "assignment" && have.has("exam"))))
      if (!missing.length) continue
      hasGap = true
      report.push({
        oqituvchi: inst.teacher ?? inst.teacher_user_id,
        guruh: inst.group_name ?? inst.group_id,
        tur: inst.training_type ?? "—",
        mavzu: String(inst.title).slice(0, 50),
        yetishmaydi: missing.map(slotLabel).join(", "),
      })
    }
    if (hasGap) {
      plan.push({
        teacherId: Number(instances[0].teacher_user_id),
        instances: instances.map((i) => ({
          groupId: Number(i.group_id), topicKey: String(i.topic_key), items: slotsByKey.get(String(i.topic_key))!.size,
        })),
      })
    }
  }

  if (!report.length) {
    console.log("Guruhlar orasida farq yo'q — hamma mavzular mos.")
    await pool.end()
    return
  }
  console.table(report)
  console.log(`Jami: ${plan.length} ta mavzuda, ${report.length} ta guruhda yetishmovchilik.`)

  if (!apply) {
    console.log("\nBu faqat ko'rish edi. To'ldirish uchun oxiriga --apply qo'shib qayta ishga tushiring.")
    await pool.end()
    return
  }

  let copied = 0
  for (const p of plan) {
    const groupIds = p.instances.map((i) => i.groupId)
    // Eng to'liq nusxadan boshlab — qaysi guruhda nima bo'lsa, hammasiga tarqaladi
    for (const src of [...p.instances].sort((a, b) => b.items - a.items)) {
      const res = await syncTopicToGroups(p.teacherId, src.topicKey, groupIds)
      copied += res?.itemsCopied ?? 0
    }
  }
  console.log(`\nBajarildi: ${copied} ta resurs yetishmagan guruhlarga nusxalandi (test savollari bilan).`)
  await pool.end()
}

main().catch((err) => { console.error(err); process.exit(1) })
