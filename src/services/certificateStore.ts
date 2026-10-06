import type mysql from "mysql2/promise"
import { pool, fromMysqlDate } from "./db"
import { notifySafe } from "./notificationStore"

/* ── O'qituvchi tashakkurnomasi ─────────────────────────────────────────
   "Fan resurslari"da 15 ta mavzuni to'liq to'ldirgan o'qituvchiga bir marta
   beriladi. To'liq mavzu = 4 qismning har biri bor:
     media        — video YOKI audio (fayli bilan) yoki YouTube havolasi
     presentation — taqdimot (theory) fayli
     guide        — qo'llanma fayli
     check        — test (kamida 1 savol) YOKI topshiriq
   Fayl yuklanmagan qism yoki savolsiz test sanalmaydi — talaba tomonidagi
   mavzu zanjiri ham ularni e'tiborsiz qoldiradi. ───────────────────────── */
export const CERTIFICATE_TOPIC_GOAL = 15

export type TopicPart = "media" | "presentation" | "guide" | "check"
const PARTS: TopicPart[] = ["media", "presentation", "guide", "check"]

export interface IncompleteTopic {
  subjectName: string
  title: string
  trainingType: string | null
  missing: TopicPart[]
}

export interface TeacherCertificate {
  fullName: string
  completedTopics: number
  issuedAt: string
}

export interface CertificateStatus {
  goal: number
  completedTopics: number
  /** Kamida bitta qismi bor, lekin hali to'liq bo'lmagan mavzular */
  incomplete: IncompleteTopic[]
  certificate: TeacherCertificate | null
}

interface TopicState {
  subjectName: string
  title: string
  trainingType: string | null
  hasMarker: boolean
  parts: Set<TopicPart>
}

function partOf(row: mysql.RowDataPacket): TopicPart | null {
  const hasFile = Number(row.has_file) > 0
  if (row.type === "exam") return Number(row.question_count) > 0 ? "check" : null
  if (row.type === "assignment") return hasFile || String(row.description ?? "").trim() ? "check" : null
  if (row.type !== "mavzu") return null
  switch (row.kind) {
    case "video_lesson":
    case "audio":
      return hasFile ? "media" : null
    case "youtube":
      return String(row.meeting_link ?? "").trim() ? "media" : null
    case "theory":
      return hasFile ? "presentation" : null
    case "qollanma":
      return hasFile ? "guide" : null
    default:
      return null
  }
}

/** O'qituvchining mavzulari va har birida qaysi qismlar borligi. Bitta mavzu
    parallel guruhlarga nusxalangan bo'lsa ham BITTA mavzu sanaladi (fan + tur +
    nom bo'yicha) — eng to'liq nusxasi olinadi, aks holda bitta mavzuni 15
    guruhga nusxalash tashakkurnoma berib yuborardi. */
async function teacherTopics(teacherUserId: number): Promise<TopicState[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT c.type, c.kind, c.topic_key, c.subject_name, c.title, c.training_type, c.description, c.meeting_link,
            (c.file_name IS NOT NULL OR EXISTS (SELECT 1 FROM lms_teacher_content_files f WHERE f.content_id = c.id)) AS has_file,
            (SELECT COUNT(*) FROM lms_exam_questions q WHERE q.content_id = c.id) AS question_count
       FROM lms_teacher_content c
      WHERE c.teacher_user_id = ? AND c.topic_key IS NOT NULL AND c.is_active = 1`,
    [teacherUserId]
  )

  const instances = new Map<string, TopicState>()
  for (const row of rows) {
    const key = String(row.topic_key)
    let inst = instances.get(key)
    if (!inst) {
      inst = {
        subjectName: String(row.subject_name),
        title: String(row.title),
        trainingType: row.training_type ?? null,
        hasMarker: false,
        parts: new Set(),
      }
      instances.set(key, inst)
    }
    // Mavzu nomi va turi marker'dan (teachingStore.topicTrainingType bilan bir xil)
    if (row.type === "mavzu" && row.kind === "topic") {
      inst.title = String(row.title)
      inst.trainingType = row.training_type ?? null
      inst.hasMarker = true
      continue
    }
    if (!inst.hasMarker && !inst.trainingType && row.training_type) inst.trainingType = row.training_type
    const part = partOf(row)
    if (part) inst.parts.add(part)
  }

  const topics = new Map<string, TopicState>()
  for (const inst of instances.values()) {
    const id = [inst.subjectName, inst.trainingType ?? "", inst.title].map((s) => s.trim().toLowerCase()).join("|")
    const prev = topics.get(id)
    if (!prev || inst.parts.size > prev.parts.size) topics.set(id, inst)
  }
  return Array.from(topics.values())
}

async function getTeacherCertificate(teacherUserId: number): Promise<TeacherCertificate | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT full_name, completed_topics, issued_at FROM lms_teacher_certificates WHERE teacher_user_id = ? LIMIT 1",
    [teacherUserId]
  )
  if (!rows.length) return null
  return {
    fullName: String(rows[0].full_name),
    completedTopics: Number(rows[0].completed_topics),
    issuedAt: fromMysqlDate(rows[0].issued_at),
  }
}

/** Joriy holat; 15 taga yetgan bo'lsa va hali berilmagan bo'lsa — shu yerda
    beriladi (sana = shu payt). Mavzular keyin o'chirilsa ham qaytib olinmaydi. */
export async function teacherCertificateStatus(teacherUserId: number, fullName: string): Promise<CertificateStatus> {
  const topics = await teacherTopics(teacherUserId)
  const completedTopics = topics.filter((t) => t.parts.size === PARTS.length).length
  const incomplete = topics
    .filter((t) => t.parts.size > 0 && t.parts.size < PARTS.length)
    .map((t) => ({
      subjectName: t.subjectName,
      title: t.title,
      trainingType: t.trainingType,
      missing: PARTS.filter((p) => !t.parts.has(p)),
    }))

  let certificate = await getTeacherCertificate(teacherUserId)
  if (!certificate && completedTopics >= CERTIFICATE_TOPIC_GOAL) {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      "INSERT IGNORE INTO lms_teacher_certificates (teacher_user_id, full_name, completed_topics) VALUES (?, ?, ?)",
      [teacherUserId, fullName, completedTopics]
    )
    certificate = await getTeacherCertificate(teacherUserId)
    if (result.affectedRows > 0) {
      notifySafe({
        role: "employee",
        userId: teacherUserId,
        type: "system",
        title: "Tabriklaymiz! Sizga tashakkurnoma berildi",
        body: `${CERTIFICATE_TOPIC_GOAL} ta mavzuni to'liq to'ldirganingiz uchun. Uni bosh sahifadan yuklab olishingiz mumkin.`,
        link: "/dashboard",
        i18nKey: "certificateIssued",
        i18nParams: { n: CERTIFICATE_TOPIC_GOAL },
        dedupeKey: `certificate-issued:${teacherUserId}`,
      })
    }
  } else if (certificate && fullName && certificate.fullName !== fullName) {
    // Ism keyinroq aniqroq bo'lib qolishi mumkin (HEMIS katalogi yangilangan) —
    // sana o'zgarmaydi, faqat yozilgan ism
    await pool.query("UPDATE lms_teacher_certificates SET full_name = ? WHERE teacher_user_id = ?", [fullName, teacherUserId])
    certificate = { ...certificate, fullName }
  }

  return { goal: CERTIFICATE_TOPIC_GOAL, completedTopics, incomplete, certificate }
}
