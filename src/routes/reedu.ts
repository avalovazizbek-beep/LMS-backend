import { Router, Response, NextFunction } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { studentUserId } from "../services/teachingStore"
import { fetchAcademicDebtors, type AcademicDebtor } from "./hemis"
import { isAdminUser, requirePermission } from "./admin"
import { logAudit } from "../services/auditLog"
import {
  markAlreadyEnrolled,
  createReeduGroup,
  listReeduGroups,
  getReeduGroup,
  closeReeduGroup,
  enrollDebtors,
  listEnrollments,
  getStudentEnrollments,
  setReeduSchedule,
  getReeduSchedule,
  markReeduAttendance,
  getReeduAttendance,
  getReeduAttendanceSummary,
  upsertReeduGrade,
  getReeduGrades,
  finalizeReeduEnrollment,
  getReeduRecordExport,
} from "../services/reeduStore"

const router = Router()
router.use(authMiddleware)

async function adminOnly(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const ok = await isAdminUser(req)
  if (!ok) { res.status(403).json({ success: false, message: "Admin huquqi yo'q" }); return }
  next()
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function numVal(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function textVal(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

/* ── 1-bosqich: Akademik qarzdorlarni topish (HEMIS'dan real vaqtda) ─── */
router.get("/admin/debtors", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const semester = textVal(req.query.semester) || undefined
    const { debtors, departmentId } = await fetchAcademicDebtors(req.user, semester)
    if (!departmentId) {
      res.json({ success: true, data: { debtors: [], departmentId: null, message: "HEMIS profilingizda departament aniqlanmadi" } })
      return
    }
    const withStatus = await markAlreadyEnrolled(debtors)
    res.json({ success: true, data: { debtors: withStatus, departmentId } })
  } catch (err) {
    res.status(502).json({ success: false, message: err instanceof Error ? err.message : "HEMIS'dan ma'lumot olishda xatolik" })
  }
})

/* ── 2-bosqich: Reedu guruhlar ───────────────────────────────────────── */
router.get("/admin/groups", adminOnly, async (_req: AuthRequest, res: Response): Promise<void> => {
  res.json({ success: true, data: await listReeduGroups() })
})

router.post("/admin/groups", adminOnly, requirePermission("reedu", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  const body = asRecord(req.body)
  const name = textVal(body.name)
  const subjectName = textVal(body.subjectName)
  if (!name || !subjectName) { res.status(400).json({ success: false, message: "name va subjectName majburiy" }); return }
  const id = await createReeduGroup({
    name,
    subjectName,
    teacherUserId: numVal(body.teacherUserId),
    teacherFullName: textVal(body.teacherFullName) || null,
    semester: textVal(body.semester) || null,
    createdBy: req.user?.fullName ?? req.user?.username ?? null,
  })
  void logAudit(req, "reedu.group.create", "reedu", String(id), { name, subjectName })
  res.json({ success: true, data: { id } })
})

router.get("/admin/groups/:id", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  const group = await getReeduGroup(id)
  if (!group) { res.status(404).json({ success: false, message: "Guruh topilmadi" }); return }
  const [enrollments, schedule, attendanceSummary, grades] = await Promise.all([
    listEnrollments(id),
    getReeduSchedule(id),
    getReeduAttendanceSummary(id),
    getReeduGrades(id),
  ])
  res.json({
    success: true,
    data: {
      group,
      enrollments,
      schedule,
      attendance: Array.from(attendanceSummary.entries()).map(([studentUserId, s]) => ({ studentUserId, ...s })),
      grades,
    },
  })
})

router.post("/admin/groups/:id/close", adminOnly, requirePermission("reedu", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  await closeReeduGroup(id)
  void logAudit(req, "reedu.group.close", "reedu", String(id))
  res.json({ success: true })
})

router.post("/admin/groups/:id/enroll", adminOnly, requirePermission("reedu", "create"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  const body = asRecord(req.body)
  const rawDebtors = Array.isArray(body.debtors) ? body.debtors : []
  const debtors: AcademicDebtor[] = rawDebtors
    .map((d) => {
      const r = asRecord(d)
      const studentUserId = numVal(r.studentUserId)
      const groupId = numVal(r.groupId)
      if (studentUserId === null || groupId === null) return null
      return {
        studentUserId,
        studentFullName: textVal(r.studentFullName) || "Talaba",
        studentIdNumber: textVal(r.studentIdNumber) || null,
        subjectName: textVal(r.subjectName),
        groupId,
        groupName: textVal(r.groupName),
        semester: textVal(r.semester),
        totalPoint: numVal(r.totalPoint) ?? 0,
        grade: numVal(r.grade),
      } as AcademicDebtor
    })
    .filter((d): d is AcademicDebtor => d !== null)
  if (!debtors.length) { res.status(400).json({ success: false, message: "debtors ro'yxati bo'sh" }); return }
  const inserted = await enrollDebtors(id, debtors, req.user?.fullName ?? req.user?.username ?? null)
  void logAudit(req, "reedu.enroll", "reedu", String(id), { inserted, count: debtors.length })
  res.json({ success: true, data: { inserted } })
})

/* ── 3-bosqich: Dars jadvali ─────────────────────────────────────────── */
router.put("/admin/groups/:id/schedule", adminOnly, requirePermission("reedu", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  const body = asRecord(req.body)
  const rawSlots = Array.isArray(body.slots) ? body.slots : []
  const slots = rawSlots.map((s) => {
    const r = asRecord(s)
    return { weekDay: numVal(r.weekDay) ?? 1, startTime: textVal(r.startTime), endTime: textVal(r.endTime), room: textVal(r.room) || null }
  }).filter((s) => s.startTime && s.endTime)
  await setReeduSchedule(id, slots)
  void logAudit(req, "reedu.schedule.set", "reedu", String(id), { slotCount: slots.length })
  res.json({ success: true })
})

/* ── 4-bosqich: Davomat ──────────────────────────────────────────────── */
router.post("/admin/groups/:id/attendance", adminOnly, requirePermission("reedu", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  const body = asRecord(req.body)
  const lessonDate = textVal(body.lessonDate)
  const rawRecords = Array.isArray(body.records) ? body.records : []
  if (!lessonDate || !rawRecords.length) { res.status(400).json({ success: false, message: "lessonDate va records majburiy" }); return }
  const records = rawRecords.map((r) => {
    const rec = asRecord(r)
    return { studentUserId: numVal(rec.studentUserId) ?? 0, status: (textVal(rec.status) || "present") as "present" | "absent" | "late" | "excused" }
  }).filter((r) => r.studentUserId > 0)
  await markReeduAttendance(id, lessonDate, records, req.user?.fullName ?? req.user?.username ?? null)
  void logAudit(req, "reedu.attendance.mark", "reedu", String(id), { lessonDate, count: records.length })
  res.json({ success: true })
})

router.get("/admin/groups/:id/attendance", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  res.json({ success: true, data: await getReeduAttendance(id) })
})

/* ── 5-bosqich: Nazorat (JN/ON1/ON2/YN) ─────────────────────────────── */
router.put("/admin/groups/:id/grade", adminOnly, requirePermission("reedu", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  const body = asRecord(req.body)
  const studentUserId = numVal(body.studentUserId)
  const gradeType = textVal(body.gradeType)
  if (studentUserId === null || !["JN", "ON1", "ON2", "YN"].includes(gradeType)) {
    res.status(400).json({ success: false, message: "studentUserId va gradeType (JN/ON1/ON2/YN) majburiy" }); return
  }
  const grade = body.grade === null ? null : numVal(body.grade)
  await upsertReeduGrade(id, studentUserId, gradeType as any, grade, req.user?.fullName ?? req.user?.username ?? null)
  void logAudit(req, "reedu.grade.set", "reedu", String(id), { studentUserId, gradeType, grade })
  res.json({ success: true })
})

/* ── 6-bosqich: Yakunlash va Qaydnoma ───────────────────────────────── */
router.post("/admin/groups/:id/finalize", adminOnly, requirePermission("reedu", "edit"), async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  const body = asRecord(req.body)
  const studentUserId = numVal(body.studentUserId)
  if (studentUserId === null) { res.status(400).json({ success: false, message: "studentUserId majburiy" }); return }
  const result = await finalizeReeduEnrollment(id, studentUserId)
  if (!result) { res.status(400).json({ success: false, message: "Bu talaba uchun hali baho kiritilmagan" }); return }
  void logAudit(req, "reedu.finalize", "reedu", String(id), { studentUserId, ...result })
  res.json({ success: true, data: result })
})

router.get("/admin/groups/:id/export", adminOnly, async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numVal(req.params.id)
  if (id === null) { res.status(400).json({ success: false, message: "id noto'g'ri" }); return }
  res.json({ success: true, data: await getReeduRecordExport(id) })
})

/* ── Talaba tarafi: o'zining reedu holatini ko'rish ─────────────────── */
router.get("/me", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "student") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const sId = studentUserId(req.user)
  const enrollments = await getStudentEnrollments(sId)
  const withDetails = await Promise.all(enrollments.map(async (e) => {
    const [schedule, grades] = await Promise.all([getReeduSchedule(e.reeduGroupId), getReeduGrades(e.reeduGroupId)])
    const ownGrades = grades.filter((g) => g.studentUserId === sId)
    return { ...e, schedule, grades: ownGrades }
  }))
  res.json({ success: true, data: withDetails })
})

export default router
