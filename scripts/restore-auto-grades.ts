/**
 * O'qituvchilar buzuq «talaba javoblari» oynasiga qarab QO'LDA o'zgartirgan
 * test baholarini tizim hisoblagan haqiqiy balga qaytaradi.
 *
 * Fon (2026-11-04): Oraliq / Yakuniy nazorat va Imtihonlar sahifalaridagi
 * oyna saqlangan javobni (variantning asl raqami) optionPerms orqali yana bir
 * marta almashtirib ko'rsatardi (frontend 611a855 da tuzatildi). O'qituvchi
 * talabaning to'g'ri javoblarini «xato» deb ko'rib, bahoni qo'lda pasaytirgan.
 * Baholashning o'zi to'g'ri edi — haqiqiy bal saqlangan javoblardan aynan
 * submitExamAnswers kabi qayta hisoblanadi.
 *
 * Nima qaytariladi:
 *  1. lms_submissions: test (type='exam') bahosi qo'lda o'zgartirilgan
 *     (graded_by_user_id bor) va o'qituvchi uni buzuq oynada ko'ra olgan
 *     (option_perms + question_ids bor, moslashuvchan emas) yozuvlar →
 *     grade = haqiqiy bal, graded_by_user_id = NULL.
 *  2. lms_period_grades: jurnalda ON1/ON2/YN katagiga test topshirilgandan
 *     keyin qo'lda yozilgan baho (u test natijasidan ustun turadi) → o'chiriladi,
 *     jurnal yana test natijasini oladi.
 * Moslashuvchan / eski testlar (oyna ularni umuman ko'rsatmasdi), keyin
 * almashtirilgan savollar va topshiriqlar (assignment) tegilmaydi — ro'yxatda
 * sababi bilan ko'rsatiladi.
 *
 * Avval faqat KO'RISH (hech narsa o'zgarmaydi):
 *   npx ts-node -P scripts/tsconfig.json scripts/restore-auto-grades.ts --teacher=523
 *   npx ts-node -P scripts/tsconfig.json scripts/restore-auto-grades.ts --all
 * Bajarish (oldingi qiymatlar restore-auto-grades-backup-*.json ga yoziladi):
 *   ... --teacher=523 --apply
 */
import "dotenv/config"
import fs from "fs"
import type mysql from "mysql2/promise"
import { pool } from "../src/services/db"
import { listQuestions, type ExamQuestion } from "../src/services/examStore"

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const all = args.includes("--all")
const teachers = args
  .filter((a) => a.startsWith("--teacher="))
  .flatMap((a) => a.slice("--teacher=".length).split(","))
  .map(Number)
  .filter((n) => Number.isFinite(n) && n > 0)

if (!all && !teachers.length) {
  console.error("Qaysi o'qituvchi? --teacher=523 (vergul bilan bir nechta) yoki --all bering.")
  process.exit(1)
}

async function rows(sql: string, params: unknown[] = []) {
  const [r] = await pool.query<mysql.RowDataPacket[]>(sql, params)
  return r
}
const parse = <T,>(v: unknown): T | null => {
  if (v == null) return null
  if (typeof v !== "string") return v as T
  try { return JSON.parse(v) as T } catch { return null }
}
const scoreOf = (correct: number, total: number, max: number | null) => {
  const pct = total > 0 ? correct / total : 0
  return max && max > 0 ? Math.round(pct * max) : Math.round(pct * 100)
}

async function main() {
  const scope = all ? "" : `AND tc.teacher_user_id IN (${teachers.map(() => "?").join(",")})`
  const scopeParams = all ? [] : teachers

  // ── 1. Qo'lda o'zgartirilgan test baholari ──
  const subs = await rows(`
    SELECT s.id, s.content_id, s.student_user_id, s.student_full_name, s.grade, s.feedback, s.answers,
           s.question_ids, s.option_perms, s.submitted_at, s.graded_at, s.graded_by_user_id,
           tc.title, tc.subject_name, tc.group_id, COALESCE(g.name, CONCAT('Guruh ', tc.group_id)) AS group_name,
           tc.teacher_user_id, tc.max_score, tc.is_adaptive
      FROM lms_submissions s
      JOIN lms_teacher_content tc ON tc.id = s.content_id
      LEFT JOIN lms_groups g ON g.id = tc.group_id
     WHERE tc.type = 'exam' AND s.graded_by_user_id IS NOT NULL ${scope}
     ORDER BY group_name, tc.subject_name, tc.id, s.student_full_name`, scopeParams)

  const qCache = new Map<number, Map<number, ExamQuestion>>()
  const questionsOf = async (contentId: number) => {
    if (!qCache.has(contentId)) qCache.set(contentId, new Map((await listQuestions(contentId)).map((q) => [q.id, q])))
    return qCache.get(contentId)!
  }

  type Fix = { id: number; from: number | null; to: number; row: mysql.RowDataPacket }
  const fixes: Fix[] = []
  const skipped: { row: mysql.RowDataPacket; why: string }[] = []
  let bugMatches = 0

  for (const s of subs) {
    const qids = parse<number[]>(s.question_ids)
    const answers = parse<number[]>(s.answers)
    const perms = parse<Record<string, number[]>>(s.option_perms)
    if (Number(s.is_adaptive)) { skipped.push({ row: s, why: "moslashuvchan test — oyna uni ko'rsatmas edi" }); continue }
    if (!qids?.length || !answers || !perms) { skipped.push({ row: s, why: "eski yozuv — oyna javoblarni ko'rsatmas edi" }); continue }
    const byId = await questionsOf(Number(s.content_id))
    if (qids.some((id) => !byId.has(Number(id)))) { skipped.push({ row: s, why: "savollar keyin almashtirilgan — qo'lda tekshiring" }); continue }

    const max = s.max_score == null ? null : Number(s.max_score)
    let correct = 0, shownCorrect = 0
    for (let i = 0; i < Math.min(qids.length, answers.length); i++) {
      const q = byId.get(Number(qids[i]))!
      const a = Number(answers[i])
      if (q.correctIndexes.includes(a)) correct++
      const p = perms[String(qids[i])]
      if (p && a >= 0 && a < p.length && q.correctIndexes.includes(p[a])) shownCorrect++
    }
    const real = scoreOf(correct, qids.length, max)
    const shown = scoreOf(shownCorrect, qids.length, max)
    const cur = s.grade == null ? null : Number(s.grade)
    if (cur === real) { skipped.push({ row: s, why: `bal allaqachon haqiqiy (${real})` }); continue }
    if (cur === shown) bugMatches++
    s._real = real; s._shown = shown; s._correct = correct; s._total = qids.length
    fixes.push({ id: Number(s.id), from: cur, to: real, row: s })
  }

  // ── 2. Jurnalda test natijasini bosib qo'ygan qo'lda ON1/ON2/YN ──
  const journal = await rows(`
    SELECT pg.id, pg.group_id, pg.subject_name, pg.student_user_id, pg.grade_type, pg.grade, pg.updated_at,
           pg.teacher_user_id, COALESCE(g.name, CONCAT('Guruh ', pg.group_id)) AS group_name,
           s.student_full_name, s.grade AS exam_grade, tc.max_score, tc.title
      FROM lms_teacher_content tc
      JOIN lms_period_grades pg
        ON pg.group_id = tc.group_id AND LOWER(pg.subject_name) = LOWER(tc.subject_name)
       AND pg.grade_type = CASE WHEN tc.control_type = 'yakuniy' THEN 'YN' ELSE tc.kind END
      JOIN lms_submissions s ON s.content_id = tc.id AND s.student_user_id = pg.student_user_id
      LEFT JOIN lms_groups g ON g.id = tc.group_id
     WHERE tc.type = 'exam' AND tc.is_active = 1 AND tc.control_type IN ('oraliq', 'yakuniy')
       AND pg.grade IS NOT NULL AND pg.updated_at > s.submitted_at ${scope}
     ORDER BY group_name, pg.subject_name, pg.grade_type, s.student_full_name`, scopeParams)

  // ── Hisobot ──
  console.log(`\n${apply ? "BAJARILMOQDA" : "FAQAT KO'RISH (hech narsa o'zgarmaydi)"} · ${all ? "barcha o'qituvchilar" : `o'qituvchi: ${teachers.join(", ")}`}\n`)
  console.log(`1) Qo'lda o'zgartirilgan test baholari — qaytariladi: ${fixes.length} ta (shundan ${bugMatches} tasi aynan buzuq oyna ko'rsatgan balga teng)`)
  let last = ""
  for (const f of fixes) {
    const r = f.row
    const head = `   ${r.group_name} · ${r.subject_name} · «${r.title}» (test ${r.content_id})`
    if (head !== last) { console.log(head); last = head }
    const mark = f.from === r._shown ? "  [buzuq oyna bali]" : ""
    console.log(`      ${String(r.student_full_name).padEnd(40)} ${String(f.from).padStart(4)} → ${String(f.to).padStart(4)}   (${r._correct}/${r._total} to'g'ri)${mark}`)
  }
  if (skipped.length) {
    console.log(`\n   Tegilmaydi: ${skipped.length} ta`)
    for (const k of skipped) console.log(`      ${k.row.group_name} · test ${k.row.content_id} · ${k.row.student_full_name}: ${k.why}`)
  }
  console.log(`\n2) Jurnalda test natijasi o'rniga qo'lda yozilgan ON/YN — o'chiriladi: ${journal.length} ta`)
  for (const j of journal) {
    console.log(`      ${j.group_name} · ${j.subject_name} · ${j.grade_type} · ${String(j.student_full_name).padEnd(40)} jurnalda ${Number(j.grade)}% (test: ${j.exam_grade}${j.max_score ? "/" + j.max_score : "%"})`)
  }

  if (!apply) {
    console.log(`\nBajarish uchun xuddi shu buyruqqa --apply qo'shing.\n`)
    return
  }

  const backupFile = `restore-auto-grades-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  fs.writeFileSync(backupFile, JSON.stringify({
    submissions: fixes.map((f) => ({ id: f.id, grade: f.from, feedback: f.row.feedback, graded_at: f.row.graded_at, graded_by_user_id: f.row.graded_by_user_id })),
    periodGrades: journal.map((j) => ({ id: j.id, group_id: j.group_id, subject_name: j.subject_name, student_user_id: j.student_user_id, grade_type: j.grade_type, grade: j.grade, teacher_user_id: j.teacher_user_id, updated_at: j.updated_at })),
  }, null, 2))

  let done = 0, changedMeanwhile = 0
  for (const f of fixes) {
    // Faqat ko'rilgan holatda bo'lsa o'zgartiriladi (shu orada boshqa baho qo'yilgan bo'lsa — tegilmaydi)
    const [res] = await pool.query<mysql.ResultSetHeader>(
      `UPDATE lms_submissions SET grade = ?, feedback = 'Avtomatik baholandi', graded_by_user_id = NULL, graded_at = submitted_at
        WHERE id = ? AND graded_by_user_id IS NOT NULL AND ${f.from === null ? "grade IS NULL" : "grade = ?"}`,
      f.from === null ? [f.to, f.id] : [f.to, f.id, f.from])
    if (res.affectedRows) done++; else changedMeanwhile++
  }
  let removed = 0
  for (const j of journal) {
    const [res] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_period_grades WHERE id = ?", [j.id])
    removed += res.affectedRows
  }
  console.log(`\nTayyor: ${done} ta test bahosi qaytarildi${changedMeanwhile ? `, ${changedMeanwhile} tasi shu orada o'zgargani uchun tegilmadi` : ""}; jurnaldan ${removed} ta qo'lda baho o'chirildi.`)
  console.log(`Oldingi qiymatlar: ${backupFile}\n`)
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
