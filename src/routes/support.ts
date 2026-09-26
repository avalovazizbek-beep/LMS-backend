import fs from "fs"
import path from "path"
import { Router, Response } from "express"
import type { RowDataPacket, ResultSetHeader } from "mysql2"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { pool } from "../services/db"
import {
  teacherUserId,
  studentUserId,
  chatUploadsDir,
  sanitizeFilename,
  safeMimeType,
} from "../services/teachingStore"
import { streamPrivateFile } from "./teaching"
import { getUserAdminRole } from "./admin"
import { notifySafe, type NotificationOwner } from "../services/notificationStore"

const router = Router()
router.use(authMiddleware)

/* ── Yordamchilar ──────────────────────────────────────────────────── */
function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}
function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

type RecipientType = "teacher" | "dean" | "admin"

interface ConversationRow extends RowDataPacket {
  id: number
  student_user_id: number
  student_name: string
  student_group_id: number | null
  student_group_name: string | null
  student_phone: string | null
  student_id_number: string | null
  recipient_type: RecipientType
  recipient_user_id: number | null
  recipient_name: string | null
  subject: string
  status: "open" | "closed"
  closed_by_name: string | null
  created_at: string
  closed_at: string | null
  last_message_at: string
}

/** Talabaning o'z ma'lumotlari — hemis_students_directory'dan (guruh, F.I.Sh),
 *  telefon esa profil JSON'idan yoki OAuth sessiyasidan (agar directory'da
 *  bo'lmasa) olinadi — bu jadvalda alohida "phone" ustuni yo'q. */
async function getStudentContactInfo(req: AuthRequest) {
  const uid = studentUserId(req.user)
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT hemis_id, full_name, group_id, group_name, student_id_number, profile FROM hemis_students_directory WHERE hemis_id = ? LIMIT 1",
    [uid]
  )
  const row = rows[0]
  let phone: string | null = null
  if (row?.profile) {
    try {
      const parsed = JSON.parse(String(row.profile))
      if (typeof parsed?.phone === "string" && parsed.phone.trim()) phone = parsed.phone.trim()
    } catch { /* profil JSON emas — e'tiborsiz qoldiriladi */ }
  }
  if (!phone) {
    const sessionProfile = req.user?.studentProfile as Record<string, unknown> | undefined
    const p = sessionProfile?.phone
    if (typeof p === "string" && p.trim()) phone = p.trim()
  }
  return {
    userId: uid,
    fullName: (row?.full_name as string) || req.user?.fullName || "Talaba",
    groupId: row?.group_id != null ? Number(row.group_id) : (req.user?.groupId != null ? Number(req.user.groupId) : null),
    groupName: (row?.group_name as string) || null,
    phone,
    studentIdNumber: (row?.student_id_number as string) || null,
  }
}

/** Talaba ham, murojaat yo'naltirilgan taraf ham (aynan shu o'qituvchi, yoki
 *  dean/admin puli) shu suhbatni ko'ra va javob yoza oladi. */
async function canAccessConversation(req: AuthRequest, conv: ConversationRow): Promise<boolean> {
  if (req.user?.role === "student") {
    return studentUserId(req.user) === conv.student_user_id
  }
  if (conv.recipient_type === "teacher") {
    // Faqat xodim sessiyasi — boshqa turdagi hisobning raqamli ID'si tasodifan
    // o'qituvchi ID'siga teng bo'lib qolsa ham suhbatni ko'rmasligi uchun
    return req.user?.role === "employee" && teacherUserId(req.user) === conv.recipient_user_id
  }
  const adminRole = await getUserAdminRole(req)
  if (conv.recipient_type === "dean") return adminRole === "dean"
  if (conv.recipient_type === "admin") return adminRole === "admin"
  return false
}

/** Faqat murojaat yo'naltirilgan taraf (talaba emas) suhbatni yakunlay oladi. */
async function isRecipientOf(req: AuthRequest, conv: ConversationRow): Promise<boolean> {
  if (req.user?.role === "student") return false
  return canAccessConversation(req, conv)
}

/* ── Bildirishnomalar ─────────────────────────────────────────────────
   Murojaat qabul qiluvchilari: o'qituvchi — aniq bitta xodim; dekanat/admin
   — shu roldagi barcha xodimlar (lms_permissions + o'zgarmas admin). */
async function staffRecipients(conv: Pick<ConversationRow, "recipient_type" | "recipient_user_id">): Promise<NotificationOwner[]> {
  if (conv.recipient_type === "teacher") {
    return conv.recipient_user_id ? [{ role: "employee", userId: conv.recipient_user_id }] : []
  }
  const owners = new Map<string, NotificationOwner>()
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT hemis_id, hemis_role FROM lms_permissions WHERE lms_role = ?",
    [conv.recipient_type]
  )
  for (const r of rows) {
    const userId = Number(r.hemis_id)
    if (!Number.isFinite(userId) || userId <= 0) continue
    const role = r.hemis_role === "student" ? "student" : "employee"
    owners.set(`${role}:${userId}`, { role, userId })
  }
  const fixedAdmin = Number(String(process.env.FIXED_ADMIN_HEMIS_ID ?? "").trim())
  if (conv.recipient_type === "admin" && Number.isFinite(fixedAdmin) && fixedAdmin > 0) {
    owners.set(`employee:${fixedAdmin}`, { role: "employee", userId: fixedAdmin })
  }
  return [...owners.values()]
}

function staffLink(conv: Pick<ConversationRow, "recipient_type">, id: number) {
  return conv.recipient_type === "teacher" ? `/oqituvchi-kabineti/murojaatlar?c=${id}` : `/admin/murojaatlar?c=${id}`
}

/** Talaba yozsa — qabul qiluvchi xodim(lar)ga, xodim yozsa — talabaga. */
async function notifyConversationActivity(
  conv: ConversationRow,
  fromStudent: boolean,
  senderName: string,
) {
  try {
    if (fromStudent) {
      for (const owner of await staffRecipients(conv)) {
        notifySafe({
          ...owner,
          type: "support",
          title: "Murojaatga yangi xabar",
          body: `${conv.student_name}: ${conv.subject}`,
          link: staffLink(conv, conv.id),
          i18nKey: "supportMessage",
          i18nParams: { name: conv.student_name, subject: conv.subject },
        })
      }
    } else {
      notifySafe({
        role: "student",
        userId: conv.student_user_id,
        type: "support",
        title: "Murojaatingizga javob keldi",
        body: `${senderName}: ${conv.subject}`,
        link: `/murojaatlar?c=${conv.id}`,
        i18nKey: "supportReply",
        i18nParams: { name: senderName, subject: conv.subject },
      })
    }
  } catch (err) {
    console.warn("[support] bildirishnoma yuborilmadi:", (err as { message?: string })?.message ?? err)
  }
}

async function loadConversation(id: number): Promise<ConversationRow | null> {
  const [rows] = await pool.query<ConversationRow[]>("SELECT * FROM lms_conversations WHERE id = ?", [id])
  return rows[0] ?? null
}

/* ── GET /api/support/teachers — talabaning guruhiga dars beradigan
   o'qituvchilar ro'yxati (murojaat yo'naltirish uchun select) ────────── */
router.get("/teachers", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "student") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const info = await getStudentContactInfo(req)
  if (!info.groupId) {
    res.json({ success: true, data: [] })
    return
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT t.user_id, ed.full_name
     FROM (
       SELECT user_id FROM lms_teacher_groups WHERE group_id = ?
       UNION
       SELECT teacher_user_id AS user_id FROM lms_teacher_content WHERE group_id = ? AND is_active = 1 AND teacher_user_id IS NOT NULL
     ) t
     JOIN hemis_employees_directory ed ON ed.hemis_id = t.user_id
     ORDER BY ed.full_name`,
    [info.groupId, info.groupId]
  )
  res.json({ success: true, data: rows.map(r => ({ userId: Number(r.user_id), fullName: String(r.full_name) })) })
})

/* ── POST /api/support/conversations — yangi murojaat ochish ─────────── */
router.post("/conversations", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "student") {
    res.status(403).json({ success: false, message: "Faqat talaba murojaat yubora oladi" })
    return
  }
  const body = req.body as Record<string, unknown>
  const recipientType = textValue(body.recipientType) as RecipientType
  const subject = textValue(body.subject)
  const message = textValue(body.message)

  if (!["teacher", "dean", "admin"].includes(recipientType)) {
    res.status(400).json({ success: false, message: "Kimga murojaat qilinayotgani noto'g'ri" })
    return
  }
  if (!subject || !message) {
    res.status(400).json({ success: false, message: "Mavzu va xabar matni majburiy" })
    return
  }

  const info = await getStudentContactInfo(req)

  let recipientUserId: number | null = null
  let recipientName: string | null = null
  if (recipientType === "teacher") {
    const rid = numberValue(body.recipientUserId)
    if (!rid) {
      res.status(400).json({ success: false, message: "O'qituvchi tanlanmagan" })
      return
    }
    if (!info.groupId) {
      res.status(400).json({ success: false, message: "Sizning guruhingiz aniqlanmadi" })
      return
    }
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ed.full_name FROM (
         SELECT user_id FROM lms_teacher_groups WHERE group_id = ? AND user_id = ?
         UNION
         SELECT teacher_user_id AS user_id FROM lms_teacher_content WHERE group_id = ? AND is_active = 1 AND teacher_user_id = ?
       ) t JOIN hemis_employees_directory ed ON ed.hemis_id = t.user_id LIMIT 1`,
      [info.groupId, rid, info.groupId, rid]
    )
    if (!rows.length) {
      res.status(400).json({ success: false, message: "Bu o'qituvchi sizning guruhingizga tegishli emas" })
      return
    }
    recipientUserId = rid
    recipientName = String(rows[0].full_name)
  }

  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO lms_conversations
       (student_user_id, student_name, student_group_id, student_group_name, student_phone, student_id_number,
        recipient_type, recipient_user_id, recipient_name, subject, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    [info.userId, info.fullName, info.groupId, info.groupName, info.phone, info.studentIdNumber,
      recipientType, recipientUserId, recipientName, subject]
  )
  const conversationId = result.insertId

  await pool.query(
    `INSERT INTO lms_conversation_messages (conversation_id, sender_user_id, sender_name, sender_role, body)
     VALUES (?, ?, ?, 'student', ?)`,
    [conversationId, info.userId, info.fullName, message]
  )

  res.json({ success: true, data: { id: conversationId } })

  // Qabul qiluvchi(lar)ga "yangi murojaat" bildirishnomasi
  try {
    for (const owner of await staffRecipients({ recipient_type: recipientType, recipient_user_id: recipientUserId })) {
      notifySafe({
        ...owner,
        type: "support",
        title: "Yangi murojaat",
        body: `${info.fullName}: ${subject}`,
        link: staffLink({ recipient_type: recipientType }, conversationId),
        i18nKey: "supportNew",
        i18nParams: { name: info.fullName, subject },
      })
    }
  } catch (err) {
    console.warn("[support] bildirishnoma yuborilmadi:", (err as { message?: string })?.message ?? err)
  }
})

/* ── GET /api/support/conversations — mening murojaatlarim ro'yxati ──── */
router.get("/conversations", async (req: AuthRequest, res: Response): Promise<void> => {
  let where: string
  let params: unknown[]
  let viewerRoleFn: (recipientType: RecipientType) => string

  if (req.user?.role === "student") {
    where = "student_user_id = ?"
    params = [studentUserId(req.user)]
    viewerRoleFn = () => "student"
  } else {
    const conditions: string[] = []
    params = []
    if (req.user?.role === "employee") {
      conditions.push("(recipient_type = 'teacher' AND recipient_user_id = ?)")
      params.push(teacherUserId(req.user))
    }
    const adminRole = await getUserAdminRole(req)
    if (adminRole === "dean") conditions.push("recipient_type = 'dean'")
    if (adminRole === "admin") conditions.push("recipient_type = 'admin'")
    where = conditions.length ? conditions.join(" OR ") : "1 = 0"
    viewerRoleFn = (recipientType) => recipientType
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.*,
       (SELECT sender_role FROM lms_conversation_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_sender_role
     FROM lms_conversations c
     WHERE ${where}
     ORDER BY last_message_at DESC
     LIMIT 200`,
    params
  )

  res.json({
    success: true,
    data: rows.map(r => ({
      id: r.id,
      subject: r.subject,
      recipientType: r.recipient_type,
      recipientName: r.recipient_name,
      studentName: r.student_name,
      studentGroupName: r.student_group_name,
      status: r.status,
      createdAt: r.created_at,
      lastMessageAt: r.last_message_at,
      closedByName: r.closed_by_name,
      hasUnread: r.status === "open" && r.last_sender_role !== viewerRoleFn(r.recipient_type),
    })),
  })
})

/* ── GET /api/support/conversations/:id — to'liq suhbat + xabarlar ───── */
router.get("/conversations/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.id)
  if (!id) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }

  const conv = await loadConversation(id)
  if (!conv) { res.status(404).json({ success: false, message: "Suhbat topilmadi" }); return }
  if (!(await canAccessConversation(req, conv))) { res.status(403).json({ success: false, message: "Ruxsat yo'q" }); return }

  const [msgRows] = await pool.query<RowDataPacket[]>(
    "SELECT * FROM lms_conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC",
    [id]
  )

  const canClose = await isRecipientOf(req, conv)

  res.json({
    success: true,
    data: {
      id: conv.id,
      subject: conv.subject,
      recipientType: conv.recipient_type,
      recipientName: conv.recipient_name,
      status: conv.status,
      createdAt: conv.created_at,
      closedAt: conv.closed_at,
      closedByName: conv.closed_by_name,
      canClose,
      canReply: conv.status === "open",
      student: {
        fullName: conv.student_name,
        groupName: conv.student_group_name,
        phone: conv.student_phone,
        studentIdNumber: conv.student_id_number,
      },
      messages: msgRows.map(m => ({
        id: m.id,
        senderRole: m.sender_role,
        senderName: m.sender_name,
        body: m.body,
        attachment: m.attachment_path
          ? { url: `/api/support/messages/${m.id}/file`, name: m.attachment_name, mime: m.attachment_mime, size: m.attachment_size }
          : null,
        createdAt: m.created_at,
        // Tomonlar QAT'IY: talaba har doim bir tomonda, murojaat qabul
        // qiluvchi (o'qituvchi/dekanat/admin) har doim boshqa tomonda —
        // kim tomosha qilayotganidan qat'i nazar (odatiy chat ilovasidagi
        // "mening xabarim o'ngda" mantig'i emas, balki tarix sifatida
        // barcha ko'ruvchilar uchun bir xil ko'rinishi kerak).
        isStudent: m.sender_role === "student",
      })),
    },
  })
})

/* ── POST /api/support/conversations/:id/messages — matnli javob ─────── */
router.post("/conversations/:id/messages", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.id)
  if (!id) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }

  const conv = await loadConversation(id)
  if (!conv) { res.status(404).json({ success: false, message: "Suhbat topilmadi" }); return }
  if (!(await canAccessConversation(req, conv))) { res.status(403).json({ success: false, message: "Ruxsat yo'q" }); return }
  if (conv.status !== "open") { res.status(409).json({ success: false, message: "Suhbat yakunlangan — endi xabar yozib bo'lmaydi" }); return }

  const text = textValue((req.body as Record<string, unknown>)?.body)
  if (!text) { res.status(400).json({ success: false, message: "Xabar matni bo'sh" }); return }

  const senderRole = req.user?.role === "student" ? "student" : conv.recipient_type
  const senderId = req.user?.role === "student" ? studentUserId(req.user) : teacherUserId(req.user)
  const senderName = req.user?.fullName || req.user?.username || "Foydalanuvchi"

  await pool.query(
    "INSERT INTO lms_conversation_messages (conversation_id, sender_user_id, sender_name, sender_role, body) VALUES (?, ?, ?, ?, ?)",
    [id, senderId, senderName, senderRole, text]
  )
  await pool.query("UPDATE lms_conversations SET last_message_at = NOW() WHERE id = ?", [id])

  res.json({ success: true, message: "Yuborildi" })
  void notifyConversationActivity(conv, senderRole === "student", senderName)
})

/* ── Fayl biriktirib yuborish — xom oqim (multipart emas), teaching.ts
   dagi bilan bir xil naqsh: metama'lumot query'da, fayl bayti body'da. ── */
const CHAT_MAX_UPLOAD_BYTES = Number(process.env.LOCAL_RESOURCE_MAX_BYTES || 2 * 1024 * 1024 * 1024)
const CHAT_ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt",
  ".zip", ".rar",
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
])

function receiveChatAttachment(req: AuthRequest, res: Response): Promise<{ originalName: string; mimeType: string; size: number; relativePath: string } | null> {
  return new Promise((resolve) => {
    const originalName = textValue(req.query.filename) || "fayl"
    const ext = path.extname(originalName).toLowerCase()
    if (ext && !CHAT_ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ success: false, message: "Bu turdagi fayl qabul qilinmaydi" })
      resolve(null)
      return
    }
    const contentLength = Number(req.headers["content-length"] || 0)
    if (contentLength > CHAT_MAX_UPLOAD_BYTES) {
      res.status(413).json({ success: false, message: "Fayl hajmi ruxsat etilgan chegaradan katta" })
      resolve(null)
      return
    }

    const storedName = sanitizeFilename(originalName)
    const relativePath = `/chat/${storedName}`
    const absolutePath = path.join(chatUploadsDir(), storedName)
    const stream = fs.createWriteStream(absolutePath)
    let written = 0
    let done = false

    function fail(status: number, message: string) {
      if (done) return
      done = true
      req.unpipe(stream)
      stream.destroy()
      fs.rm(absolutePath, { force: true }, () => undefined)
      res.status(status).json({ success: false, message })
      resolve(null)
    }

    req.on("data", (chunk: Buffer) => {
      written += chunk.length
      if (written > CHAT_MAX_UPLOAD_BYTES) fail(413, "Fayl hajmi ruxsat etilgan chegaradan katta")
    })
    req.on("error", () => fail(400, "Fayl yuklashda xatolik"))
    stream.on("error", () => fail(500, "Fayl saqlanmadi"))

    stream.on("finish", () => {
      if (done) return
      done = true
      resolve({ originalName, mimeType: safeMimeType(originalName), size: written, relativePath })
    })

    req.pipe(stream)
  })
}

router.post("/conversations/:id/attachment", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.id)
  if (!id) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }

  const conv = await loadConversation(id)
  if (!conv) { res.status(404).json({ success: false, message: "Suhbat topilmadi" }); return }
  if (!(await canAccessConversation(req, conv))) { res.status(403).json({ success: false, message: "Ruxsat yo'q" }); return }
  if (conv.status !== "open") { res.status(409).json({ success: false, message: "Suhbat yakunlangan — endi fayl yuborib bo'lmaydi" }); return }

  const file = await receiveChatAttachment(req, res)
  if (!file) return

  const caption = textValue(req.query.body) || null
  const senderRole = req.user?.role === "student" ? "student" : conv.recipient_type
  const senderId = req.user?.role === "student" ? studentUserId(req.user) : teacherUserId(req.user)
  const senderName = req.user?.fullName || req.user?.username || "Foydalanuvchi"

  await pool.query(
    `INSERT INTO lms_conversation_messages
       (conversation_id, sender_user_id, sender_name, sender_role, body, attachment_path, attachment_name, attachment_mime, attachment_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, senderId, senderName, senderRole, caption, file.relativePath, file.originalName, file.mimeType, file.size]
  )
  await pool.query("UPDATE lms_conversations SET last_message_at = NOW() WHERE id = ?", [id])

  res.json({ success: true, message: "Fayl yuborildi" })
  void notifyConversationActivity(conv, senderRole === "student", senderName)
})

/* ── GET /api/support/messages/:messageId/file — biriktirilgan faylni olish ── */
router.get("/messages/:messageId/file", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.messageId)
  if (!id) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.attachment_path, m.attachment_name, m.attachment_mime,
            c.id AS conv_id, c.student_user_id, c.recipient_type, c.recipient_user_id
     FROM lms_conversation_messages m
     JOIN lms_conversations c ON c.id = m.conversation_id
     WHERE m.id = ?`,
    [id]
  )
  const row = rows[0]
  if (!row || !row.attachment_path) { res.status(404).json({ success: false, message: "Fayl topilmadi" }); return }

  const pseudoConv = {
    id: row.conv_id,
    student_user_id: row.student_user_id,
    recipient_type: row.recipient_type,
    recipient_user_id: row.recipient_user_id,
  } as ConversationRow
  if (!(await canAccessConversation(req, pseudoConv))) { res.status(403).json({ success: false, message: "Ruxsat yo'q" }); return }

  streamPrivateFile(req, res, row.attachment_path, row.attachment_name, row.attachment_mime || "application/octet-stream")
})

/* ── POST /api/support/conversations/:id/close — faqat qabul qiluvchi
   taraf (o'qituvchi, yoki dekanat/admin pulidan biri) yakunlay oladi ──── */
router.post("/conversations/:id/close", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.id)
  if (!id) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }

  const conv = await loadConversation(id)
  if (!conv) { res.status(404).json({ success: false, message: "Suhbat topilmadi" }); return }
  if (!(await isRecipientOf(req, conv))) {
    res.status(403).json({ success: false, message: "Faqat murojaat yo'naltirilgan taraf suhbatni yakunlashi mumkin" })
    return
  }
  if (conv.status === "closed") { res.json({ success: true, message: "Allaqachon yakunlangan" }); return }

  const closerName = req.user?.fullName || req.user?.username || "Xodim"
  await pool.query(
    "UPDATE lms_conversations SET status = 'closed', closed_at = NOW(), closed_by_name = ? WHERE id = ?",
    [closerName, id]
  )
  await pool.query(
    `INSERT INTO lms_conversation_messages (conversation_id, sender_user_id, sender_name, sender_role, body)
     VALUES (?, ?, ?, ?, ?)`,
    [id, teacherUserId(req.user), closerName, conv.recipient_type, `— Suhbat "${closerName}" tomonidan yakunlandi —`]
  )

  res.json({ success: true, message: "Suhbat yakunlandi" })
  notifySafe({
    role: "student",
    userId: conv.student_user_id,
    type: "support",
    title: "Murojaat yakunlandi",
    body: conv.subject,
    link: `/murojaatlar?c=${conv.id}`,
    i18nKey: "supportClosed",
    i18nParams: { subject: conv.subject, name: closerName },
  })
})

export default router
