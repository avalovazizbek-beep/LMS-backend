import type mysql from "mysql2/promise"
import { pool } from "./db"
import { getSubmissionForStudent, type SubmissionRecord } from "./teachingStore"

export const EXAM_PASS_RATIO = 0.6

export function isExamPassed(grade: number | null | undefined, maxScore: number | null | undefined): boolean {
  if (grade == null) return false
  const threshold = (maxScore && maxScore > 0) ? maxScore * EXAM_PASS_RATIO : 60
  return grade >= threshold
}

export type QuestionDifficulty = "oson" | "orta" | "qiyin"

export interface ExamQuestion {
  id: number
  contentId: number
  questionText: string
  imageUrl: string | null
  optionImages: (string | null)[] | null
  options: string[]
  correctIndex: number
  correctIndexes: number[]
  points: number
  orderIndex: number
  difficulty: QuestionDifficulty
}

export interface ExamQuestionInput {
  questionText: string
  imageUrl?: string | null
  optionImages?: (string | null)[] | null
  options: string[]
  correctIndex: number
  correctIndexes?: number[]
  points: number
  difficulty?: QuestionDifficulty
}

function mapQuestionRow(row: mysql.RowDataPacket): ExamQuestion {
  const options = typeof row.options === "string" ? JSON.parse(row.options) : row.options
  const correctIndexesRaw = row.correct_indexes
    ? (typeof row.correct_indexes === "string" ? JSON.parse(row.correct_indexes) : row.correct_indexes)
    : null
  const correctIndex = Number(row.correct_index)
  const correctIndexes: number[] = Array.isArray(correctIndexesRaw)
    ? correctIndexesRaw.map(Number)
    : [correctIndex]

  let optionImages: (string | null)[] | null = null
  if (row.option_images) {
    try {
      const raw = typeof row.option_images === "string" ? JSON.parse(row.option_images) : row.option_images
      if (Array.isArray(raw)) optionImages = raw.map((v: unknown) => (typeof v === "string" && v ? v : null))
    } catch { /* ignore */ }
  }

  return {
    id: Number(row.id),
    contentId: Number(row.content_id),
    questionText: String(row.question_text),
    imageUrl: row.image_url ? String(row.image_url) : null,
    optionImages,
    options: Array.isArray(options) ? options.map(String) : [],
    correctIndex,
    correctIndexes,
    points: Number(row.points),
    orderIndex: Number(row.order_index),
    difficulty: (row.difficulty === "oson" || row.difficulty === "qiyin" ? row.difficulty : "orta") as QuestionDifficulty,
  }
}

export async function listQuestions(contentId: number): Promise<ExamQuestion[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM lms_exam_questions WHERE content_id = ? ORDER BY order_index ASC, id ASC",
    [contentId]
  )
  return rows.map(mapQuestionRow)
}

export async function countQuestions(contentId: number): Promise<number> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM lms_exam_questions WHERE content_id = ?",
    [contentId]
  )
  return Number(rows[0]?.cnt ?? 0)
}

function shuffleIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i)
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export function buildOptionPerms(questions: ExamQuestion[]): Record<number, number[]> {
  const perms: Record<number, number[]> = {}
  for (const q of questions) {
    perms[q.id] = shuffleIndices(q.options.length)
  }
  return perms
}

export async function saveExamSession(
  contentId: number,
  studentUserId: number,
  questionIds: number[],
  optionPerms: Record<number, number[]>
): Promise<void> {
  await pool.query(
    `INSERT INTO lms_exam_sessions (content_id, student_user_id, question_ids, option_perms)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE question_ids = VALUES(question_ids), option_perms = VALUES(option_perms), created_at = CURRENT_TIMESTAMP`,
    [contentId, studentUserId, JSON.stringify(questionIds), JSON.stringify(optionPerms)]
  )
}

export async function deleteExamSession(contentId: number, studentUserId: number): Promise<void> {
  await pool.query(
    "DELETE FROM lms_exam_sessions WHERE content_id = ? AND student_user_id = ?",
    [contentId, studentUserId]
  )
}

export interface ExamSession {
  questionIds: number[]
  optionPerms: Record<number, number[]>
}

export async function getExamSession(contentId: number, studentUserId: number): Promise<ExamSession | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT question_ids, option_perms FROM lms_exam_sessions WHERE content_id = ? AND student_user_id = ?",
    [contentId, studentUserId]
  )
  if (!rows.length) return null
  const rawIds = rows[0].question_ids
  const ids: unknown = typeof rawIds === "string" ? JSON.parse(rawIds) : rawIds
  if (!Array.isArray(ids)) return null

  const rawPerms = rows[0].option_perms
  let perms: Record<number, number[]> = {}
  if (rawPerms) {
    try { perms = typeof rawPerms === "string" ? JSON.parse(rawPerms) : rawPerms } catch { perms = {} }
  }
  return { questionIds: ids.map(Number), optionPerms: perms }
}

export async function replaceQuestions(contentId: number, questions: ExamQuestionInput[]): Promise<ExamQuestion[]> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query("DELETE FROM lms_exam_questions WHERE content_id = ?", [contentId])
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]
      const correctIndexes = q.correctIndexes?.length ? q.correctIndexes : [q.correctIndex]
      const correctIndex = correctIndexes[0]
      const optionImagesJson = q.optionImages?.some(v => v)
        ? JSON.stringify(q.optionImages)
        : null
      await conn.query(
        `INSERT INTO lms_exam_questions
           (content_id, question_text, image_url, option_images, options, correct_index, correct_indexes, points, order_index, difficulty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contentId,
          q.questionText.trim(),
          q.imageUrl ?? null,
          optionImagesJson,
          JSON.stringify(q.options),
          correctIndex,
          JSON.stringify(correctIndexes),
          q.points,
          i,
          q.difficulty === "oson" || q.difficulty === "qiyin" ? q.difficulty : "orta",
        ]
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return listQuestions(contentId)
}

export interface ExamSubmitResult {
  submission: SubmissionRecord
  score: number
}

export async function submitExamAnswers(
  contentId: number,
  studentUserId: number,
  studentFullName: string,
  groupId: number | null,
  answers: number[],
  sessionQuestionIds?: number[],
  optionPerms?: Record<number, number[]>,
  contentMaxScore?: number | null,
): Promise<ExamSubmitResult> {
  // Use session question IDs if provided (shuffled/subset), otherwise fall back to all questions in order
  let questions: ExamQuestion[]
  if (sessionQuestionIds?.length) {
    const allById = new Map<number, ExamQuestion>()
    for (const q of await listQuestions(contentId)) allById.set(q.id, q)
    questions = sessionQuestionIds.map(id => allById.get(id)).filter(Boolean) as ExamQuestion[]
  } else {
    questions = await listQuestions(contentId)
  }
  let correctCount = 0
  for (let i = 0; i < Math.min(questions.length, answers.length); i++) {
    const correctSet = new Set(questions[i].correctIndexes)
    if (correctSet.has(answers[i])) correctCount++
  }
  // Scale score to contentMaxScore (e.g. if teacher set max=8, 75% correct → 6 points)
  const rawPct = questions.length > 0 ? correctCount / questions.length : 0
  const score = (contentMaxScore && contentMaxScore > 0)
    ? Math.round(rawPct * contentMaxScore)
    : Math.round(rawPct * 100)

  const qIdsJson = sessionQuestionIds?.length ? JSON.stringify(sessionQuestionIds) : null
  const permsJson = optionPerms && Object.keys(optionPerms).length ? JSON.stringify(optionPerms) : null

  await pool.query(
    `INSERT INTO lms_submissions
      (content_id, student_user_id, student_full_name, group_id, comment, submitted_at,
       answers, grade, feedback, graded_at, graded_by_user_id, auto_graded, attempts_used, question_ids, option_perms)
     VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP, NULL, 1, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       student_full_name = VALUES(student_full_name),
       submitted_at      = CURRENT_TIMESTAMP,
       answers           = VALUES(answers),
       grade             = VALUES(grade),
       feedback          = VALUES(feedback),
       graded_at         = CURRENT_TIMESTAMP,
       graded_by_user_id = NULL,
       auto_graded       = 1,
       attempts_used     = attempts_used + 1,
       question_ids      = VALUES(question_ids),
       option_perms      = VALUES(option_perms)`,
    [contentId, studentUserId, studentFullName, groupId, JSON.stringify(answers), score, "Avtomatik baholandi", qIdsJson, permsJson]
  )

  const submission = await getSubmissionForStudent(contentId, studentUserId)
  if (!submission) throw new Error("Topshiriq saqlanmadi")
  return { submission, score }
}

/* ── Moslashuvchan (adaptive) test ────────────────────────────────────
   Har bir javobdan keyin keyingi savolning qiyinligi talabaning
   natijasiga qarab moslashadi: to'g'ri bo'lsa qiyinroq, xato bo'lsa
   osonroq savol tanlanadi. Holat lms_exam_sessions.adaptive_state'da
   (JSON) saqlanadi — talaba sahifani yangilasa ham jarayon davom etadi. */
export interface AdaptiveAnswerRecord {
  questionId: number
  selectedIndex: number
  correct: boolean
  difficulty: QuestionDifficulty
}

export interface AdaptiveState {
  answers: AdaptiveAnswerRecord[]
  currentDifficulty: QuestionDifficulty
  currentQuestionId?: number | null
  currentOptionPerm?: number[] | null
}

function defaultAdaptiveState(): AdaptiveState {
  return { answers: [], currentDifficulty: "orta", currentQuestionId: null, currentOptionPerm: null }
}

export async function getAdaptiveState(contentId: number, studentUserId: number): Promise<AdaptiveState> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT adaptive_state FROM lms_exam_sessions WHERE content_id = ? AND student_user_id = ?",
    [contentId, studentUserId]
  )
  const raw = rows[0]?.adaptive_state
  if (!raw) return defaultAdaptiveState()
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    if (parsed && Array.isArray(parsed.answers)) {
      return {
        answers: parsed.answers,
        currentDifficulty: parsed.currentDifficulty === "oson" || parsed.currentDifficulty === "qiyin" ? parsed.currentDifficulty : "orta",
        currentQuestionId: typeof parsed.currentQuestionId === "number" ? parsed.currentQuestionId : null,
        currentOptionPerm: Array.isArray(parsed.currentOptionPerm) ? parsed.currentOptionPerm : null,
      }
    }
  } catch { /* ignore */ }
  return defaultAdaptiveState()
}

export async function saveAdaptiveState(contentId: number, studentUserId: number, state: AdaptiveState): Promise<void> {
  await pool.query(
    `INSERT INTO lms_exam_sessions (content_id, student_user_id, question_ids, adaptive_state)
     VALUES (?, ?, '[]', ?)
     ON DUPLICATE KEY UPDATE adaptive_state = VALUES(adaptive_state)`,
    [contentId, studentUserId, JSON.stringify(state)]
  )
}

export function nextAdaptiveDifficulty(current: QuestionDifficulty, correct: boolean): QuestionDifficulty {
  if (correct) return current === "oson" ? "orta" : "qiyin"
  return current === "qiyin" ? "orta" : "oson"
}

/** Javob berilmagan savollar orasidan joriy qiyinlikka mos bo'lganini tanlaydi;
    shu qiyinlikda savol qolmagan bo'lsa, o'rta darajaga, keyin istalgan savolga o'tadi. */
export function pickAdaptiveQuestion(pool: ExamQuestion[], answeredIds: Set<number>, difficulty: QuestionDifficulty): ExamQuestion | null {
  const remaining = pool.filter(q => !answeredIds.has(q.id))
  if (!remaining.length) return null
  const exact = remaining.filter(q => q.difficulty === difficulty)
  if (exact.length) return exact[Math.floor(Math.random() * exact.length)]
  const mid = remaining.filter(q => q.difficulty === "orta")
  if (mid.length) return mid[Math.floor(Math.random() * mid.length)]
  return remaining[Math.floor(Math.random() * remaining.length)]
}

export function difficultyWeight(d: QuestionDifficulty): number {
  return d === "oson" ? 1 : d === "qiyin" ? 3 : 2
}

/** Moslashuvchan test tugagach, qiyinlikka qarab tortilgan ball bilan yakuniy baho qo'yadi */
export async function finalizeAdaptiveExam(
  contentId: number,
  studentUserId: number,
  studentFullName: string,
  groupId: number | null,
  state: AdaptiveState,
  contentMaxScore?: number | null,
): Promise<ExamSubmitResult> {
  const totalWeight = state.answers.reduce((s, a) => s + difficultyWeight(a.difficulty), 0)
  const earnedWeight = state.answers.reduce((s, a) => s + (a.correct ? difficultyWeight(a.difficulty) : 0), 0)
  const rawPct = totalWeight > 0 ? earnedWeight / totalWeight : 0
  const score = (contentMaxScore && contentMaxScore > 0)
    ? Math.round(rawPct * contentMaxScore)
    : Math.round(rawPct * 100)

  const questionIds = state.answers.map(a => a.questionId)
  const answers = state.answers.map(a => a.selectedIndex)

  await pool.query(
    `INSERT INTO lms_submissions
      (content_id, student_user_id, student_full_name, group_id, comment, submitted_at,
       answers, grade, feedback, graded_at, graded_by_user_id, auto_graded, attempts_used, question_ids, option_perms)
     VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, ?, ?, ?, CURRENT_TIMESTAMP, NULL, 1, 1, ?, NULL)
     ON DUPLICATE KEY UPDATE
       student_full_name = VALUES(student_full_name),
       submitted_at      = CURRENT_TIMESTAMP,
       answers           = VALUES(answers),
       grade             = VALUES(grade),
       feedback          = VALUES(feedback),
       graded_at         = CURRENT_TIMESTAMP,
       graded_by_user_id = NULL,
       auto_graded       = 1,
       attempts_used     = attempts_used + 1,
       question_ids      = VALUES(question_ids)`,
    [contentId, studentUserId, studentFullName, groupId, JSON.stringify(answers), score, "Avtomatik baholandi (moslashuvchan test)", JSON.stringify(questionIds)]
  )

  const submission = await getSubmissionForStudent(contentId, studentUserId)
  if (!submission) throw new Error("Topshiriq saqlanmadi")
  return { submission, score }
}

/* ── Imtihon paytidagi buzilishlar (proctoring) ─────────────────────── */
export type ViolationType =
  | "fullscreen_exit"
  | "tab_blur"
  | "screenshot_attempt"
  | "face_mismatch"
  | "no_face"
  | "multi_face"
  | "liveness"

export async function recordExamViolation(input: {
  contentId: number
  studentUserId: number
  studentFullName: string
  groupId: number | null
  violationType: ViolationType
  detail?: string | null
}): Promise<void> {
  await pool.query(
    `INSERT INTO lms_exam_violations (content_id, student_user_id, student_full_name, group_id, violation_type, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.contentId, input.studentUserId, input.studentFullName, input.groupId, input.violationType, input.detail ?? null]
  )
}

export interface ViolationSummaryRow {
  studentUserId: number
  studentFullName: string
  counts: Record<string, number>
  total: number
  lastAt: string
}

export async function getExamViolationsSummary(contentId: number): Promise<ViolationSummaryRow[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT student_user_id, student_full_name, violation_type, COUNT(*) AS cnt, MAX(created_at) AS last_at
     FROM lms_exam_violations WHERE content_id = ?
     GROUP BY student_user_id, student_full_name, violation_type`,
    [contentId]
  )
  const map = new Map<number, ViolationSummaryRow>()
  for (const r of rows) {
    const sid = Number(r.student_user_id)
    if (!map.has(sid)) {
      map.set(sid, { studentUserId: sid, studentFullName: String(r.student_full_name), counts: {}, total: 0, lastAt: String(r.last_at) })
    }
    const entry = map.get(sid)!
    entry.counts[String(r.violation_type)] = Number(r.cnt)
    entry.total += Number(r.cnt)
    if (String(r.last_at) > entry.lastAt) entry.lastAt = String(r.last_at)
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total)
}
