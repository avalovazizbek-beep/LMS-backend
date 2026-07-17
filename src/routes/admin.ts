import { Router, Response, NextFunction } from "express"
import type { RowDataPacket } from "mysql2"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { pool } from "../services/db"
import { listTeacherContent, getTeacherContent, updateTeacherContent } from "../services/teachingStore"

const router = Router()
router.use(authMiddleware)

/* ── Helpers ─────────────────────────────────────────────────────────── */
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
}
function textVal(...args: unknown[]): string {
  for (const a of args) if (typeof a === "string" && a.trim()) return a.trim()
  return ""
}

const AUTO_ADMIN_CODES = new Set(["super_admin", "api"])

function extractHemisRoleCodes(employeeProfile: unknown): string[] {
  const profile = asRecord(employeeProfile)
  const codes: string[] = []

  const roles = profile.roles
  if (Array.isArray(roles)) {
    for (const r of roles) {
      const code = typeof r === "string" ? r : textVal(asRecord(r).code, asRecord(r).name)
      if (code) codes.push(code.toLowerCase())
    }
  }
  const typeCode = textVal(asRecord(profile.type).code, String(profile.type ?? ""), String(profile.employee_type ?? ""))
  if (typeCode && !codes.includes(typeCode.toLowerCase())) codes.push(typeCode.toLowerCase())

  return codes
}

function getHemisId(req: AuthRequest): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.username ?? "")
}

async function isAdminUser(req: AuthRequest): Promise<boolean> {
  const user = req.user
  if (!user) return false

  // Auto-admin: super_admin or api HEMIS role
  const profileRoles = extractHemisRoleCodes(user.employeeProfile)
  if (profileRoles.some(r => AUTO_ADMIN_CODES.has(r))) return true

  // DB-granted admin
  const hemisId = getHemisId(req)
  if (!hemisId) return false
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT lms_role FROM lms_permissions WHERE hemis_id = ?",
    [hemisId]
  )
  return rows[0]?.lms_role === "admin"
}

async function adminOnly(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const ok = await isAdminUser(req)
  if (!ok) { res.status(403).json({ success: false, message: "Admin huquqi yo'q" }); return }
  next()
}

/* ── GET /api/admin/check ───────────────────────────────────────────── */
router.get("/check", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = req.user
  if (!user) { res.status(401).json({ success: false }); return }

  const profileRoles = extractHemisRoleCodes(user.employeeProfile)
  const isAutoAdmin = profileRoles.some(r => AUTO_ADMIN_CODES.has(r))

  let dbRole: string | null = null
  const hemisId = getHemisId(req)
  if (hemisId) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT lms_role FROM lms_permissions WHERE hemis_id = ?",
      [hemisId]
    )
    dbRole = rows[0]?.lms_role ?? null
  }

  const isAdmin = isAutoAdmin || dbRole === "admin"
  res.json({
    success: true,
    isAdmin,
    name: textVal(String(user.fullName ?? ""), String(user.username ?? "")),
    role: user.role,
    hemisRoles: profileRoles,
    lmsRole: isAutoAdmin ? "admin" : (dbRole ?? "none"),
  })
})

/* ── GET /api/admin/users ───────────────────────────────────────────── */
router.get("/users", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : ""
  const roleFilter = typeof req.query.lms_role === "string" ? req.query.lms_role : ""
  const limitVal = Math.min(Number(req.query.limit ?? 100), 500)
  const offsetVal = Number(req.query.offset ?? 0)

  let sql = `
    SELECT
      hu.hemis_id,
      hu.full_name,
      hu.role AS hemis_role,
      hu.username,
      hu.profile,
      hu.created_at,
      hu.updated_at,
      p.lms_role,
      p.granted_by,
      p.granted_at,
      p.note,
      (SELECT COUNT(*) FROM lms_teacher_content tc WHERE CAST(hu.hemis_id AS UNSIGNED) = tc.teacher_user_id) AS content_count,
      (SELECT COUNT(*) FROM lms_platform_sessions ps WHERE ps.user_id = CAST(hu.hemis_id AS UNSIGNED) ORDER BY NULL) AS session_count
    FROM hemis_users hu
    LEFT JOIN lms_permissions p ON p.hemis_id = hu.hemis_id
    WHERE 1=1
  `
  const params: unknown[] = []

  if (search) {
    sql += " AND (hu.full_name LIKE ? OR hu.username LIKE ? OR hu.hemis_id LIKE ?)"
    const q = `%${search}%`
    params.push(q, q, q)
  }
  if (roleFilter) {
    sql += " AND COALESCE(p.lms_role, 'none') = ?"
    params.push(roleFilter)
  }

  sql += " ORDER BY hu.updated_at DESC LIMIT ? OFFSET ?"
  params.push(limitVal, offsetVal)

  const [[rows], [countRow]] = await Promise.all([
    pool.query<RowDataPacket[]>(sql, params),
    pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM hemis_users hu LEFT JOIN lms_permissions p ON p.hemis_id = hu.hemis_id WHERE 1=1${search ? " AND (hu.full_name LIKE ? OR hu.username LIKE ? OR hu.hemis_id LIKE ?)" : ""}${roleFilter ? " AND COALESCE(p.lms_role,'none')=?" : ""}`,
      params.slice(0, params.length - 2)
    ),
  ])

  const users = rows.map(r => {
    let profile: Record<string, unknown> = {}
    try { profile = JSON.parse(r.profile || "{}") } catch { /* noop */ }
    const roles = Array.isArray(profile.roles) ? profile.roles : []
    const roleCodes = roles.map((rr: unknown) =>
      typeof rr === "string" ? rr : textVal(asRecord(rr).code, asRecord(rr).name)
    )
    const isAutoAdmin = roleCodes.some((c: string) => AUTO_ADMIN_CODES.has(c.toLowerCase()))
    return {
      hemisId: r.hemis_id,
      fullName: r.full_name,
      username: r.username,
      hemisRole: r.hemis_role,
      hemisRoleCodes: roleCodes,
      lmsRole: r.lms_role ?? (isAutoAdmin ? "admin" : null),
      isAutoAdmin,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
      note: r.note,
      contentCount: Number(r.content_count ?? 0),
      sessionCount: Number(r.session_count ?? 0),
      lastSeen: r.updated_at,
      createdAt: r.created_at,
    }
  })

  res.json({ success: true, data: users, total: Number((countRow as RowDataPacket[])[0]?.total ?? 0) })
})

/* ── PATCH /api/admin/users/:hemisId/role ──────────────────────────── */
router.patch("/users/:hemisId/role", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const { hemisId } = req.params
  const { lmsRole, note } = req.body as { lmsRole: string; note?: string }
  const validRoles = ["admin", "teacher", "student", "blocked", "pending"]
  if (!validRoles.includes(lmsRole)) {
    res.status(400).json({ success: false, message: "Noto'g'ri rol" }); return
  }

  const grantedBy = textVal(String(req.user?.fullName ?? ""), String(req.user?.username ?? ""))

  // Get user info
  const [userRows] = await pool.query<RowDataPacket[]>(
    "SELECT full_name, role FROM hemis_users WHERE hemis_id = ?", [hemisId]
  )
  const userRow = userRows[0]

  await pool.query(
    `INSERT INTO lms_permissions (hemis_id, full_name, hemis_role, lms_role, granted_by, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE lms_role=VALUES(lms_role), granted_by=VALUES(granted_by), note=VALUES(note), updated_at=NOW()`,
    [hemisId, userRow?.full_name ?? "", userRow?.role ?? "", lmsRole, grantedBy, note ?? null]
  )

  res.json({ success: true, message: "Ruxsat yangilandi" })
})

/* ── GET /api/admin/stats ───────────────────────────────────────────── */
router.get("/stats", adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  const [[counts]] = await Promise.all([
    pool.query<RowDataPacket[]>(`
      SELECT
        (SELECT COUNT(*) FROM hemis_users WHERE role='student') AS total_students,
        (SELECT COUNT(*) FROM hemis_users WHERE role='employee') AS total_employees,
        (SELECT COUNT(*) FROM lms_permissions WHERE lms_role='admin') AS granted_admins,
        (SELECT COUNT(*) FROM lms_teacher_content WHERE is_active=1) AS total_content,
        (SELECT COUNT(*) FROM lms_teacher_content WHERE is_active=1 AND (kind LIKE '%video%' OR resource_type='video')) AS total_videos,
        (SELECT COUNT(*) FROM lms_meetings) AS total_meetings,
        (SELECT COUNT(*) FROM face_requests WHERE status='pending') AS face_pending,
        (SELECT COUNT(*) FROM lms_submissions) AS total_submissions,
        (SELECT COUNT(*) FROM lms_content_progress WHERE completed=1) AS total_completions
    `),
  ])

  const row = (counts as RowDataPacket[])[0] ?? {}
  res.json({
    success: true,
    data: {
      totalStudents: Number(row.total_students ?? 0),
      totalEmployees: Number(row.total_employees ?? 0),
      grantedAdmins: Number(row.granted_admins ?? 0),
      totalContent: Number(row.total_content ?? 0),
      totalVideos: Number(row.total_videos ?? 0),
      totalMeetings: Number(row.total_meetings ?? 0),
      facePending: Number(row.face_pending ?? 0),
      totalSubmissions: Number(row.total_submissions ?? 0),
      totalCompletions: Number(row.total_completions ?? 0),
    },
  })
})

/* ── GET /api/admin/teacher-stats ──────────────────────────────────── */
router.get("/teacher-stats", adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  // ── Avtomatik 1:1 moslashtirish (hemis_users ↔ lms_teacher_content) ──
  // Agar kontentda nom topilmagan o'qituvchilar va hemis_users'da
  // teacher_user_id=NULL bo'lgan xodimlar soni teng bo'lsa (1:1),
  // ularni avtomatik bog'laymiz.
  try {
    // Kontentda bor lekin hemis_users'da mos yozuv yo'q teacher_user_id'lar
    const [unmatched] = await pool.query<RowDataPacket[]>(`
      SELECT DISTINCT tc.teacher_user_id FROM lms_teacher_content tc
      WHERE tc.is_active = 1
        AND NOT EXISTS (
          SELECT 1 FROM hemis_users hu WHERE hu.teacher_user_id = tc.teacher_user_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM lms_platform_sessions ps
          WHERE ps.user_id = tc.teacher_user_id AND ps.role = 'employee'
            AND ps.full_name LIKE '% %'
        )
      ORDER BY tc.teacher_user_id
    `)
    // hemis_users'da teacher_user_id=NULL bo'lgan xodimlar
    const [employees] = await pool.query<RowDataPacket[]>(`
      SELECT hemis_id, full_name FROM hemis_users
      WHERE role = 'employee' AND teacher_user_id IS NULL AND full_name IS NOT NULL AND full_name LIKE '% %'
      ORDER BY updated_at DESC
    `)

    if (unmatched.length > 0 && unmatched.length === employees.length) {
      for (let i = 0; i < unmatched.length; i++) {
        const tid = Number(unmatched[i].teacher_user_id)
        const emp = employees[i]
        // hemis_users.teacher_user_id ni to'ldirish
        await pool.query(`UPDATE hemis_users SET teacher_user_id = ? WHERE hemis_id = ?`, [tid, emp.hemis_id])
        // Platform sessiyasiga ham yozish (COALESCE uchun)
        await pool.query(
          `INSERT INTO lms_platform_sessions (user_id, full_name, group_id, role, login_at, last_seen_at)
           VALUES (?, ?, NULL, 'employee', NOW(), NOW())`,
          [tid, emp.full_name]
        )
      }
    }
  } catch { /* moslashtirish xatosi bo'lsa ham davom etamiz */ }

  // Start from lms_teacher_content so teachers without hemis_users entry still appear
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      tc.teacher_user_id AS teacher_id,
      COALESCE(
        NULLIF(TRIM(MAX(hu.full_name)), ''),
        NULLIF(TRIM(MAX(JSON_UNQUOTE(JSON_EXTRACT(hu.profile, '$.full_name')))), ''),
        NULLIF(TRIM(MAX(JSON_UNQUOTE(JSON_EXTRACT(hu.profile, '$.name')))), ''),
        NULLIF(TRIM(MAX(ps.full_name)), ''),
        CONCAT('O\\'qituvchi #', tc.teacher_user_id)
      ) AS full_name,
      COALESCE(MAX(hu.updated_at), MAX(ps.login_at))                                 AS last_seen,
      COUNT(DISTINCT CASE WHEN NOT (tc.type='mavzu' AND tc.kind='topic') THEN tc.topic_key ELSE NULL END) AS mavzular,
      COUNT(DISTINCT CASE WHEN tc.kind='video_lesson' THEN tc.topic_key ELSE NULL END) AS videolar,
      COUNT(DISTINCT CASE WHEN tc.kind='audio'        THEN tc.topic_key ELSE NULL END) AS audiolar,
      COUNT(DISTINCT CASE WHEN tc.kind='theory'       THEN tc.topic_key ELSE NULL END) AS taqdimotlar,
      COUNT(DISTINCT CASE WHEN tc.kind='qollanma'     THEN tc.topic_key ELSE NULL END) AS qollanmalar,
      COUNT(DISTINCT CASE WHEN tc.type='exam'         THEN tc.topic_key ELSE NULL END) AS testlar,
      COUNT(DISTINCT CASE WHEN tc.type='assignment'   THEN tc.topic_key ELSE NULL END) AS amaliy,
      COUNT(DISTINCT tc.group_id)                                                      AS guruhlar,
      COUNT(DISTINCT COALESCE(cp.student_user_id, ma.user_id))                         AS students_completed,
      COUNT(DISTINCT sub.student_user_id)                                              AS students_submitted,
      COUNT(DISTINCT m.id)                                                             AS meeting_count
    FROM lms_teacher_content tc
    LEFT JOIN hemis_users hu
      ON hu.teacher_user_id = tc.teacher_user_id
      OR CAST(hu.hemis_id AS UNSIGNED) = tc.teacher_user_id
    LEFT JOIN (
      SELECT user_id, MAX(full_name) AS full_name, MAX(login_at) AS login_at
      FROM lms_platform_sessions WHERE role = 'employee' GROUP BY user_id
    ) ps ON ps.user_id = tc.teacher_user_id
    LEFT JOIN lms_content_progress cp
      ON cp.content_id = tc.id AND cp.completed = 1
    LEFT JOIN lms_submissions sub
      ON sub.content_id = tc.id
    LEFT JOIN lms_meetings m
      ON m.created_by_user_id = tc.teacher_user_id
    LEFT JOIN lms_meeting_attendance ma
      ON ma.meeting_id = m.id AND ma.group_id IS NOT NULL
    WHERE tc.is_active = 1
    GROUP BY tc.teacher_user_id
    ORDER BY mavzular DESC, last_seen DESC
    LIMIT 200
  `)

  const data = rows.map(r => ({
    hemisId: String(r.teacher_id),
    fullName: r.full_name ?? `O'qituvchi #${r.teacher_id}`,
    lastSeen: r.last_seen,
    mavzular: Number(r.mavzular ?? 0),
    videolar: Number(r.videolar ?? 0),
    audiolar: Number(r.audiolar ?? 0),
    taqdimotlar: Number(r.taqdimotlar ?? 0),
    qollanmalar: Number(r.qollanmalar ?? 0),
    testlar: Number(r.testlar ?? 0),
    amaliy: Number(r.amaliy ?? 0),
    guruhlar: Number(r.guruhlar ?? 0),
    studentsCompleted: Number(r.students_completed ?? 0),
    studentsSubmitted: Number(r.students_submitted ?? 0),
    meetingCount: Number(r.meeting_count ?? 0),
  }))

  res.json({ success: true, data })
})

/* ── GET /api/admin/teacher-stats/:teacherId/topics — o'qituvchining
   mavzu/kontent ro'yxati (talabalar emas — faqat nom va biriktirilgan
   material turlari) ──────────────────────────────────────────────── */
router.get("/teacher-stats/:teacherId/topics", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = Number(req.params.teacherId)
  if (!Number.isFinite(teacherId) || teacherId <= 0) {
    res.status(400).json({ success: false, message: "Noto'g'ri o'qituvchi ID" }); return
  }

  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      tc.topic_key,
      COALESCE(MAX(CASE WHEN tc.kind='topic' THEN tc.title END), MIN(tc.title)) AS title,
      MAX(tc.subject_name) AS subject_name,
      MAX(tc.group_id) AS group_id,
      MAX(g.name) AS group_name,
      MAX(tc.created_at) AS created_at,
      SUM(tc.kind='video_lesson') AS has_video,
      SUM(tc.kind='audio')        AS has_audio,
      SUM(tc.kind='theory')       AS has_theory,
      SUM(tc.kind='qollanma')     AS has_qollanma,
      SUM(tc.kind='youtube')      AS has_youtube,
      SUM(tc.type='exam')         AS has_test,
      SUM(tc.type='assignment')   AS has_assignment
    FROM lms_teacher_content tc
    LEFT JOIN lms_groups g ON g.id = tc.group_id
    WHERE tc.teacher_user_id = ? AND tc.is_active = 1 AND tc.topic_key IS NOT NULL
    GROUP BY tc.topic_key
    HAVING has_video > 0 OR has_audio > 0 OR has_theory > 0 OR has_qollanma > 0
        OR has_youtube > 0 OR has_test > 0 OR has_assignment > 0
    ORDER BY created_at DESC
    LIMIT 500
  `, [teacherId])

  res.json({
    success: true,
    data: rows.map(r => ({
      topicKey: String(r.topic_key),
      title: String(r.title ?? r.topic_key),
      subjectName: r.subject_name ? String(r.subject_name) : null,
      groupId: r.group_id != null ? Number(r.group_id) : null,
      groupName: r.group_name ? String(r.group_name) : null,
      hasVideo: Number(r.has_video) > 0,
      hasAudio: Number(r.has_audio) > 0,
      hasTheory: Number(r.has_theory) > 0,
      hasQollanma: Number(r.has_qollanma) > 0,
      hasYoutube: Number(r.has_youtube) > 0,
      hasTest: Number(r.has_test) > 0,
      hasAssignment: Number(r.has_assignment) > 0,
    })),
  })
})

/* ── GET /api/admin/teacher-stats/:teacherId/students ──────────────── */
router.get("/teacher-stats/:teacherId/students", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = Number(req.params.teacherId)
  if (!Number.isFinite(teacherId) || teacherId <= 0) {
    res.status(400).json({ success: false, message: "Noto'g'ri o'qituvchi ID" }); return
  }

  // Content totals for this teacher
  const [tcRows] = await pool.query<RowDataPacket[]>(`
    SELECT
      COUNT(DISTINCT CASE WHEN NOT (type='mavzu' AND kind='topic') THEN topic_key ELSE NULL END) AS total_content,
      COUNT(DISTINCT CASE WHEN kind='video_lesson' THEN topic_key ELSE NULL END)      AS total_videos,
      COUNT(DISTINCT CASE WHEN type='exam'         THEN topic_key ELSE NULL END)      AS total_exams,
      COUNT(DISTINCT CASE WHEN type='assignment'   THEN topic_key ELSE NULL END)      AS total_assignments
    FROM lms_teacher_content
    WHERE teacher_user_id = ? AND is_active = 1
  `, [teacherId])

  const tc = tcRows[0] ?? {}

  // Per-student stats
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT
      sl.student_user_id,
      MAX(sl.student_full_name) AS student_name,
      COUNT(DISTINCT cp.content_id) AS done_topics,
      COUNT(DISTINCT sub.content_id) AS done_submissions,
      ROUND(AVG(sub.grade), 1) AS avg_grade,
      ROUND(COALESCE(SUM(cp.max_position_seconds), 0) / 60.0, 1) AS watch_minutes
    FROM (
      SELECT s.student_user_id, s.student_full_name
      FROM lms_submissions s
      JOIN lms_teacher_content t2 ON t2.id = s.content_id AND t2.teacher_user_id = ? AND t2.is_active = 1
      UNION ALL
      SELECT p.student_user_id, NULL
      FROM lms_content_progress p
      JOIN lms_teacher_content t3 ON t3.id = p.content_id AND t3.teacher_user_id = ? AND t3.is_active = 1
      UNION ALL
      -- Faqat meeting orqali qatnashgan (video/test progressi bo'lmagan) talabalar ham
      -- ro'yxatga kirsin — aks holda "meetinglar ko'p, talabalar 0" ko'rinishi chiqadi.
      SELECT ma.user_id, ma.full_name
      FROM lms_meeting_attendance ma
      JOIN lms_meetings m ON m.id = ma.meeting_id AND m.created_by_user_id = ?
      WHERE ma.group_id IS NOT NULL
    ) sl
    LEFT JOIN lms_content_progress cp
      ON cp.student_user_id = sl.student_user_id
      AND cp.completed = 1
      AND cp.content_id IN (SELECT id FROM lms_teacher_content WHERE teacher_user_id = ? AND is_active = 1)
    LEFT JOIN lms_submissions sub
      ON sub.student_user_id = sl.student_user_id
      AND sub.content_id IN (SELECT id FROM lms_teacher_content WHERE teacher_user_id = ? AND is_active = 1)
    GROUP BY sl.student_user_id
    ORDER BY done_topics DESC, done_submissions DESC
    LIMIT 500
  `, [teacherId, teacherId, teacherId, teacherId, teacherId])

  res.json({
    success: true,
    totals: {
      totalContent: Number(tc.total_content ?? 0),
      totalTopics: Number(tc.total_content ?? 0),
      totalExams: Number(tc.total_exams ?? 0),
      totalVideos: Number(tc.total_videos ?? 0),
      totalAssignments: Number(tc.total_assignments ?? 0),
    },
    data: rows.map(r => ({
      studentId: r.student_user_id,
      studentName: r.student_name ?? `Talaba #${r.student_user_id}`,
      doneTopics: Number(r.done_topics ?? 0),
      doneSubmissions: Number(r.done_submissions ?? 0),
      avgGrade: r.avg_grade !== null && r.avg_grade !== undefined ? Number(r.avg_grade) : null,
      watchMinutes: Number(r.watch_minutes ?? 0),
    })),
  })
})

/* ── GET /api/admin/settings ────────────────────────────────────────── */
router.get("/settings", adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT key_name, value FROM lms_settings")
  const settings: Record<string, string> = {}
  for (const r of rows as RowDataPacket[]) settings[String(r.key_name)] = String(r.value)
  res.json({ success: true, data: settings })
})

/* ── PUT /api/admin/settings ────────────────────────────────────────── */
router.put("/settings", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const updates = req.body as Record<string, unknown>
  const allowed = new Set(["face_block_threshold", "test_max_attempts"])

  for (const [key, val] of Object.entries(updates)) {
    if (!allowed.has(key)) continue
    const value = String(val ?? "").trim()
    if (!value) continue
    await pool.query(
      "INSERT INTO lms_settings (key_name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
      [key, value]
    )
  }

  res.json({ success: true, message: "Sozlamalar saqlandi" })
})

/* ── GET /api/admin/face-requests ──────────────────────────────────── */
router.get("/face-requests", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const status = typeof req.query.status === "string" ? req.query.status : "pending"
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, username, reason, status, admin_note, created_at, reviewed_at
     FROM face_requests
     WHERE status = ?
     ORDER BY created_at DESC
     LIMIT 100`,
    [status]
  )
  res.json({ success: true, data: rows })
})

/* ── PATCH /api/admin/face-requests/:id ────────────────────────────── */
router.patch("/face-requests/:id", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const { id } = req.params
  const { action, note } = req.body as { action: "approve" | "reject"; note?: string }
  if (!["approve", "reject"].includes(action)) {
    res.status(400).json({ success: false, message: "action approve yoki reject bo'lishi kerak" }); return
  }

  const newStatus = action === "approve" ? "approved" : "rejected"
  await pool.query(
    `UPDATE face_requests SET status=?, admin_note=?, reviewed_at=? WHERE id=?`,
    [newStatus, note ?? "", Math.floor(Date.now() / 1000), id]
  )

  // If approved, delete existing face registration so user can re-register
  if (action === "approve") {
    const [reqRows] = await pool.query<RowDataPacket[]>(
      "SELECT username FROM face_requests WHERE id=?", [id]
    )
    const username = reqRows[0]?.username
    if (username) {
      await pool.query("DELETE FROM face_registrations WHERE username=?", [username])
    }
  }

  res.json({ success: true, message: action === "approve" ? "Tasdiqlandi" : "Rad etildi" })
})

/* ── GET /api/admin/attendance ──────────────────────────────────────── */
router.get("/attendance", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const groupId = req.query.groupId ? Number(req.query.groupId) : null
  const subject = typeof req.query.subject === "string" ? req.query.subject.trim() : ""
  const date    = typeof req.query.date === "string" ? req.query.date.trim() : ""

  const where: string[] = []
  const params: unknown[] = []
  if (groupId) { where.push("a.group_id = ?"); params.push(groupId) }
  if (subject)  { where.push("LOWER(a.subject_name) = LOWER(?)"); params.push(subject) }
  if (date)     { where.push("a.lesson_date = ?"); params.push(date) }

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : ""

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.group_id, g.name AS group_name, a.subject_name, a.lesson_date,
            COUNT(*) AS total,
            SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status='absent'  THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status='excused' THEN 1 ELSE 0 END) AS excused,
            SUM(CASE WHEN a.status='late'    THEN 1 ELSE 0 END) AS late
     FROM lms_attendance a
     LEFT JOIN lms_groups g ON g.id = a.group_id
     ${whereClause}
     GROUP BY a.group_id, a.subject_name, a.lesson_date
     ORDER BY a.lesson_date DESC
     LIMIT 500`,
    params
  )

  res.json({ success: true, data: rows.map(r => ({
    groupId: Number(r.group_id),
    groupName: r.group_name ? String(r.group_name) : `Guruh ${r.group_id}`,
    subjectName: String(r.subject_name),
    lessonDate: r.lesson_date instanceof Date ? r.lesson_date.toISOString().slice(0, 10) : String(r.lesson_date),
    total: Number(r.total),
    present: Number(r.present),
    absent: Number(r.absent),
    excused: Number(r.excused),
    late: Number(r.late),
    presentPct: Number(r.total) > 0 ? Math.round((Number(r.present) / Number(r.total)) * 100) : 0,
  })) })
})

/* ── GET /api/admin/attendance/detail ───────────────────────────────── */
router.get("/attendance/detail", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const groupId = req.query.groupId ? Number(req.query.groupId) : null
  const subject = typeof req.query.subject === "string" ? req.query.subject.trim() : ""
  const date    = typeof req.query.date === "string" ? req.query.date.trim() : ""

  if (!groupId || !subject || !date) {
    res.status(400).json({ success: false, message: "groupId, subject, date majburiy" }); return
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.student_user_id, a.student_full_name, a.status, a.comment
     FROM lms_attendance a
     WHERE a.group_id = ? AND LOWER(a.subject_name) = LOWER(?) AND a.lesson_date = ?
     ORDER BY a.student_full_name`,
    [groupId, subject, date]
  )

  res.json({ success: true, data: rows.map(r => ({
    studentId: Number(r.student_user_id),
    studentName: String(r.student_full_name),
    status: String(r.status),
    comment: r.comment ?? null,
  })) })
})

/* ── GET /api/admin/attendance/students — guruh+fan bo'yicha talabalar
   ro'yxati, har birining umumiy davomat foizi bilan ──────────────────── */
router.get("/attendance/students", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const groupId = req.query.groupId ? Number(req.query.groupId) : null
  const subject = typeof req.query.subject === "string" ? req.query.subject.trim() : ""

  if (!groupId || !subject) {
    res.status(400).json({ success: false, message: "groupId, subject majburiy" }); return
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.student_user_id, MAX(a.student_full_name) AS student_full_name,
            COUNT(*) AS total,
            SUM(CASE WHEN a.status='present' THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN a.status='absent'  THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN a.status='excused' THEN 1 ELSE 0 END) AS excused,
            SUM(CASE WHEN a.status='late'    THEN 1 ELSE 0 END) AS late
     FROM lms_attendance a
     WHERE a.group_id = ? AND LOWER(a.subject_name) = LOWER(?)
     GROUP BY a.student_user_id
     ORDER BY student_full_name`,
    [groupId, subject]
  )

  res.json({ success: true, data: rows.map(r => ({
    studentId: Number(r.student_user_id),
    studentName: String(r.student_full_name),
    total: Number(r.total),
    present: Number(r.present),
    absent: Number(r.absent),
    excused: Number(r.excused),
    late: Number(r.late),
    presentPct: Number(r.total) > 0 ? Math.round((Number(r.present) / Number(r.total)) * 100) : 0,
  })) })
})

/* ── GET /api/admin/attendance/student-detail — bitta talabaning
   guruh+fan bo'yicha sana-sana davomat tarixi ─────────────────────────── */
router.get("/attendance/student-detail", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const groupId   = req.query.groupId ? Number(req.query.groupId) : null
  const subject   = typeof req.query.subject === "string" ? req.query.subject.trim() : ""
  const studentId = req.query.studentId ? Number(req.query.studentId) : null

  if (!groupId || !subject || !studentId) {
    res.status(400).json({ success: false, message: "groupId, subject, studentId majburiy" }); return
  }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.lesson_date, a.status, a.comment
     FROM lms_attendance a
     WHERE a.group_id = ? AND LOWER(a.subject_name) = LOWER(?) AND a.student_user_id = ?
     ORDER BY a.lesson_date DESC`,
    [groupId, subject, studentId]
  )

  res.json({ success: true, data: rows.map(r => ({
    lessonDate: r.lesson_date instanceof Date ? r.lesson_date.toISOString().slice(0, 10) : String(r.lesson_date),
    status: String(r.status),
    comment: r.comment ?? null,
  })) })
})

/* ── GET /api/admin/teacher-journal ─────────────────────────────────── */
router.get("/teacher-journal", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = req.query.teacherId ? Number(req.query.teacherId) : null
  const groupId   = req.query.groupId   ? Number(req.query.groupId)   : null
  const subject   = typeof req.query.subject === "string" ? req.query.subject.trim() : ""

  if (!teacherId || !groupId || !subject) {
    res.status(400).json({ success: false, message: "teacherId, groupId, subject majburiy" }); return
  }

  // Get unique topics for teacher+subject+group
  const [topicRows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT topic_key, MIN(title) AS title, SUM(max_score) AS total_max
     FROM lms_teacher_content
     WHERE teacher_user_id = ? AND group_id = ? AND LOWER(subject_name) = LOWER(?) AND is_active = 1 AND topic_key IS NOT NULL
     GROUP BY topic_key
     ORDER BY topic_key`,
    [teacherId, groupId, subject]
  )

  // Get roster from group
  const [rosterRows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT student_user_id, MAX(student_full_name) AS student_full_name
     FROM lms_attendance
     WHERE group_id = ? AND LOWER(subject_name) = LOWER(?)
     GROUP BY student_user_id
     ORDER BY student_full_name`,
    [groupId, subject]
  )

  // Content for this teacher+group+subject
  const [contentRows] = await pool.query<RowDataPacket[]>(
    `SELECT id, topic_key, type, max_score, completion_points
     FROM lms_teacher_content
     WHERE teacher_user_id = ? AND group_id = ? AND LOWER(subject_name) = LOWER(?) AND is_active = 1 AND topic_key IS NOT NULL`,
    [teacherId, groupId, subject]
  )
  const contentIds = contentRows.map(r => Number(r.id))
  const studentIds = rosterRows.map(r => Number(r.student_user_id))

  let progressMap = new Map<string, boolean>()
  let subMap = new Map<string, number | null>()

  if (contentIds.length && studentIds.length) {
    const [progRows] = await pool.query<RowDataPacket[]>(
      `SELECT content_id, student_user_id, completed FROM lms_content_progress WHERE content_id IN (?) AND student_user_id IN (?)`,
      [contentIds, studentIds]
    )
    for (const p of progRows) progressMap.set(`${p.content_id}:${p.student_user_id}`, Boolean(p.completed))

    const [subRows] = await pool.query<RowDataPacket[]>(
      `SELECT content_id, student_user_id, grade FROM lms_submissions WHERE content_id IN (?) AND student_user_id IN (?)`,
      [contentIds, studentIds]
    )
    for (const s of subRows) subMap.set(`${s.content_id}:${s.student_user_id}`, s.grade !== null ? Number(s.grade) : null)
  }

  const topics = topicRows.map((t, i) => ({
    key: String(t.topic_key),
    idx: i + 1,
    title: String(t.title || t.topic_key),
    maxScore: Number(t.total_max || 0),
  }))

  const students = rosterRows.map(s => {
    const topicScores: Record<string, number | null> = {}
    for (const topic of topics) {
      const relevant = contentRows.filter(c => c.topic_key === topic.key)
      let earned = 0; let hasActivity = false
      for (const c of relevant) {
        if (c.type === "exam" || c.type === "assignment") {
          const g = subMap.get(`${c.id}:${s.student_user_id}`)
          if (g !== undefined) { earned += g ?? 0; hasActivity = true }
        } else {
          const done = progressMap.get(`${c.id}:${s.student_user_id}`)
          if (done && (c.completion_points ?? 0) > 0) { earned += Number(c.completion_points); hasActivity = true }
        }
      }
      topicScores[topic.key] = hasActivity ? earned : null
    }
    const totalMax = topics.reduce((s, t) => s + t.maxScore, 0)
    const scores = topics.map(t => topicScores[t.key] ?? 0)
    const jn = totalMax > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / totalMax) * 1000) / 10 : null
    return {
      userId: Number(s.student_user_id),
      fullName: String(s.student_full_name),
      studentIdNumber: null,
      topicScores,
      jn,
      on1: null, on2: null, yn: null, attendancePct: null,
    }
  })

  res.json({ success: true, data: { topics, students } })
})

/* ── POST /api/admin/hemis-sync — LMS natijalarini HEMIS ga yuklash ─── */
router.post("/hemis-sync", adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    // Collect grades to sync to HEMIS
    const [gradeRows] = await pool.query<RowDataPacket[]>(`
      SELECT
        pg.group_id, pg.subject_name, pg.grade_type, pg.student_user_id,
        MAX(hu.full_name) AS student_name, pg.grade
      FROM lms_period_grades pg
      LEFT JOIN hemis_users hu ON CAST(hu.hemis_id AS UNSIGNED) = pg.student_user_id
      WHERE pg.grade IS NOT NULL
      ORDER BY pg.group_id, pg.subject_name, pg.grade_type
      LIMIT 1000
    `)

    const [attRows] = await pool.query<RowDataPacket[]>(`
      SELECT group_id, subject_name, lesson_date,
        SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present,
        COUNT(*) AS total
      FROM lms_attendance
      GROUP BY group_id, subject_name, lesson_date
      LIMIT 500
    `)

    // HEMIS hozircha tashqi tizimlardan baho/davomat qabul qiladigan ochiq
    // yozish (POST) endpointini bermagan — shuning uchun bu yerda faqat
    // LMS tarafidagi ma'lumotlar to'planadi, HEMIS'ga jo'natilmaydi.
    res.json({
      success: true,
      message: "Ma'lumotlar to'plandi. HEMIS hali tashqi tizimlardan yozishga ruxsat bermaydi.",
      data: {
        grades: gradeRows.length,
        attendanceDays: attRows.length,
        note: "HEMIS API endpoint va tokenni sozlang",
      },
    })
  } catch (err) {
    console.error("[admin] hemis-sync xato:", err)
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "HEMIS sync vaqtida xatolik yuz berdi",
    })
  }
})

/* ── GET /api/admin/sessions ─── kirish tarixi ──────────────────────── */
router.get("/sessions", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const limitVal = Math.min(Number(req.query.limit ?? 50), 200)
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ps.user_id, ps.full_name, ps.role, ps.group_id, ps.login_at, ps.last_seen_at, ps.logout_at,
            g.name AS group_name
     FROM lms_platform_sessions ps
     LEFT JOIN lms_groups g ON g.id = ps.group_id
     ORDER BY ps.login_at DESC
     LIMIT ?`,
    [limitVal]
  )
  res.json({ success: true, data: rows })
})

/* ── GET /api/admin/locked-assignments — yakunlangan amaliylar ─────── */
router.get("/locked-assignments", adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  const items = await listTeacherContent({ type: "assignment", isActive: false })
  res.json({ success: true, data: items })
})

/* ── GET /api/admin/teacher-info — o'qituvchi guruhlari va fanlari ─── */
router.get("/teacher-info", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const teacherId = Number(req.query.teacherId)
  if (!teacherId) { res.status(400).json({ success: false, message: "teacherId majburiy" }); return }

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT ts.group_id, COALESCE(g.name, CONCAT('Guruh #', ts.group_id)) AS group_name, ts.subject_name
     FROM lms_teacher_schedule ts
     LEFT JOIN lms_groups g ON g.id = ts.group_id
     WHERE ts.teacher_user_id = ?
     ORDER BY ts.subject_name, ts.group_id`,
    [teacherId]
  )

  const subjectSet = new Set<string>()
  const groupMap = new Map<number, string>()
  for (const r of rows) {
    if (r.subject_name) subjectSet.add(String(r.subject_name))
    if (r.group_id) groupMap.set(Number(r.group_id), String(r.group_name ?? `Guruh ${r.group_id}`))
  }

  res.json({
    success: true,
    data: {
      subjects: Array.from(subjectSet).sort(),
      groups: Array.from(groupMap.entries())
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  })
})

/* ── GET /api/admin/platform-attendance — platforma asosida davomat ─── */
router.get("/platform-attendance", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const groupId = req.query.groupId ? Number(req.query.groupId) : null
  const subject = typeof req.query.subject === "string" ? req.query.subject.trim() : ""
  const from    = typeof req.query.from === "string" ? req.query.from.trim() : ""
  const to      = typeof req.query.to === "string" ? req.query.to.trim() : ""

  if (!groupId) { res.status(400).json({ success: false, message: "groupId majburiy" }); return }

  // 1. Dars jadvali (shu guruh + fan + sana oraliq)
  const schedWhere: string[] = ["ts.group_id = ?"]
  const schedParams: unknown[] = [groupId]
  if (subject) { schedWhere.push("LOWER(ts.subject_name) = LOWER(?)"); schedParams.push(subject) }
  if (from) { schedWhere.push("ts.lesson_date >= ?"); schedParams.push(from) }
  if (to)   { schedWhere.push("ts.lesson_date <= ?"); schedParams.push(to) }

  const [schedRows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT lesson_date, subject_name FROM lms_teacher_schedule ts
     WHERE ${schedWhere.join(" AND ")} ORDER BY lesson_date LIMIT 90`,
    schedParams
  )
  if (!schedRows.length) { res.json({ success: true, data: [] }); return }

  const toDateStr = (v: unknown) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10)

  const dates = schedRows.map(r => toDateStr(r.lesson_date))
  const dateFrom = dates[0]; const dateTo = dates[dates.length - 1]

  // 2. Talabalar (platformaga kirgan, shu guruhda)
  const [studentRows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT user_id, MAX(full_name) AS full_name
     FROM lms_platform_sessions
     WHERE group_id = ? AND role = 'student'
     GROUP BY user_id`,
    [groupId]
  )
  if (!studentRows.length) { res.json({ success: true, data: [] }); return }
  const studentIds = studentRows.map(s => Number(s.user_id))

  // 3. Meetinglar (batch, lms_meeting_groups orqali)
  const [meetingRows] = await pool.query<RowDataPacket[]>(
    `SELECT m.id, DATE(m.start_time) AS meeting_date,
            TIMESTAMPDIFF(MINUTE, m.start_time, m.end_time) AS duration_min
     FROM lms_meetings m
     JOIN lms_meeting_groups mg ON mg.meeting_id = m.id AND mg.group_id = ?
     WHERE DATE(m.start_time) BETWEEN ? AND ? AND m.status IN ('live','ended')`,
    [groupId, dateFrom, dateTo]
  )

  // 4. Meeting davomiylik (talaba bo'yicha, sessiyalar orqali)
  const meetingIds = meetingRows.map(m => Number(m.id))
  let meetingAttRows: RowDataPacket[] = []
  if (meetingIds.length > 0) {
    const [r] = await pool.query<RowDataPacket[]>(
      `SELECT ma.user_id, ma.meeting_id,
              COALESCE(SUM(TIMESTAMPDIFF(MINUTE, mas.joined_at, COALESCE(mas.left_at, NOW()))), 0) AS minutes
       FROM lms_meeting_attendance ma
       JOIN lms_meeting_attendance_sessions mas ON mas.attendance_id = ma.id
       WHERE ma.meeting_id IN (?) AND ma.user_id IN (?)
       GROUP BY ma.user_id, ma.meeting_id`,
      [meetingIds, studentIds]
    )
    meetingAttRows = r
  }

  // 5. Platforma sessiyalar (talaba + sana bo'yicha daqiqa)
  const [sessionRows] = await pool.query<RowDataPacket[]>(
    `SELECT user_id, DATE(login_at) AS sess_date,
            SUM(GREATEST(TIMESTAMPDIFF(MINUTE, login_at, COALESCE(logout_at, last_seen_at, login_at)), 0)) AS total_min
     FROM lms_platform_sessions
     WHERE group_id = ? AND role = 'student' AND user_id IN (?) AND DATE(login_at) BETWEEN ? AND ?
     GROUP BY user_id, DATE(login_at)`,
    [groupId, studentIds, dateFrom, dateTo]
  )

  // Lookup maps
  const meetingByDate = new Map<string, { id: number; durationMin: number }[]>()
  for (const m of meetingRows) {
    const d = toDateStr(m.meeting_date)
    if (!meetingByDate.has(d)) meetingByDate.set(d, [])
    meetingByDate.get(d)!.push({ id: Number(m.id), durationMin: Math.max(Number(m.duration_min ?? 0), 1) })
  }

  const meetingAttMap = new Map<string, number>()
  for (const a of meetingAttRows) meetingAttMap.set(`${a.user_id}:${a.meeting_id}`, Number(a.minutes ?? 0))

  const sessionMap = new Map<string, number>()
  for (const s of sessionRows) {
    const d = toDateStr(s.sess_date)
    sessionMap.set(`${s.user_id}:${d}`, Number(s.total_min ?? 0))
  }

  // Natija
  const data = schedRows.map(schedRow => {
    const lessonDate = toDateStr(schedRow.lesson_date)
    const subjName   = String(schedRow.subject_name)
    const dayMeetings = meetingByDate.get(lessonDate) ?? []
    const hasMeeting  = dayMeetings.length > 0
    const meetingMin  = hasMeeting ? Math.max(...dayMeetings.map(m => m.durationMin)) : 0

    const students = studentRows.map(student => {
      const uid = Number(student.user_id)
      let status: "present" | "absent" = "absent"

      if (hasMeeting) {
        const minsIn = dayMeetings.reduce((acc, m) => acc + (meetingAttMap.get(`${uid}:${m.id}`) ?? 0), 0)
        if (minsIn >= meetingMin) status = "present"
      } else {
        const totalMin = sessionMap.get(`${uid}:${lessonDate}`) ?? 0
        if (totalMin >= 40) status = "present"
      }

      return { studentId: uid, studentName: String(student.full_name ?? ""), status }
    })

    const presentCount = students.filter(s => s.status === "present").length
    return {
      lessonDate, subjectName: subjName,
      total: students.length, present: presentCount,
      absent: students.length - presentCount,
      presentPct: students.length > 0 ? Math.round((presentCount / students.length) * 100) : 0,
      isMeetingDay: hasMeeting, meetingMinutes: meetingMin,
      students,
    }
  })

  res.json({ success: true, data })
})

/* ── PATCH /api/admin/content/:id/toggle — admin qulfni ochadi ──────── */
router.patch("/content/:id/toggle", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = Number(req.params.id)
  if (!id) { res.status(400).json({ success: false, message: "Noto'g'ri id" }); return }
  const existing = await getTeacherContent(id)
  if (!existing) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
  const updated = await updateTeacherContent(id, { isActive: !existing.isActive })
  res.json({ success: true, data: updated })
})

export default router
