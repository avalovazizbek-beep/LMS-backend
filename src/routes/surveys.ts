import { Router, Response, NextFunction } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { getUserAdminRole, requirePermission, requireFullAdmin } from "./admin"
import { hasPermission } from "../services/permissionsStore"
import { teacherUserId, studentUserId } from "../services/teachingStore"
import { logAudit } from "../services/auditLog"
import {
  SurveyError, SURVEY_TYPES, type SurveyManager, type SurveyRespondent,
  validateSurveyInput, normalizeTargets, getDeanFaculties, setDeanFaculties, listDeansWithFaculties, allFaculties,
  audienceOptions, previewAudience, createSurvey, updateSurvey, publishSurvey, setSurveyActive, setSurveyArchived,
  deleteSurvey, duplicateSurvey, listManagedSurveys, summarizeSurveys, getSurveyDetail, getSurveyResults,
  listParticipants, exportSurvey, listMySurveys, pendingCount, getSurveyForRespondent, submitSurveyResponse,
  runSurveyNotifications,
} from "../services/surveyStore"

/* ── /api/surveys ──────────────────────────────────────────────────────
   Foydalanuvchi (talaba/o'qituvchi):
     GET  /my                    — menga mo'ljallangan so'rovnomalar va holatim
     GET  /my/pending-count      — javob berilmagan ochiq so'rovnomalar soni
     GET  /:id                   — to'ldirish uchun savollar
     POST /:id/submit            — javob (bir marta; takrori 409)
   Boshqaruv (admin yoki dekanat — "surveys" moduli ruxsati bilan):
     /manage/...                 — yaratish, tahrirlash, e'lon, arxiv, natijalar, eksport
   Dekanat faqat o'ziga biriktirilgan fakultetlar doirasida ishlaydi
   (lms_dean_faculties — biriktirishni faqat admin qiladi). */

const router = Router()
router.use(authMiddleware)

type Handler = (req: AuthRequest, res: Response) => Promise<void>

/** Async xatolarni bitta joyda: SurveyError — o'z status/matni, qolgani — 500 */
function wrap(fn: Handler) {
  return (req: AuthRequest, res: Response) => {
    fn(req, res).catch((err) => {
      if (err instanceof SurveyError) {
        res.status(err.status).json({ success: false, message: err.message })
        return
      }
      console.error("[surveys]", req.method, req.originalUrl, (err as { message?: string })?.message ?? err)
      res.status(500).json({ success: false, message: "Server xatosi — qayta urinib ko'ring" })
    })
  }
}

function hemisIdOf(req: AuthRequest): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.username ?? "")
}

function respondentOf(req: AuthRequest): SurveyRespondent {
  const user = req.user
  const isStudent = user?.role === "student"
  const profile = (isStudent ? user?.studentProfile : user?.employeeProfile) ?? {}
  const idField = isStudent ? profile.student_id_number : profile.employee_id_number
  const idNumbers = [idField, user?.hemisLogin]
    .map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : ""))
    .filter(Boolean)
  return {
    role: isStudent ? "student" : "employee",
    userId: isStudent ? studentUserId(user) : teacherUserId(user),
    idNumbers: [...new Set(idNumbers)],
  }
}

function idParam(req: AuthRequest): number {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) throw new SurveyError(400, "ID noto'g'ri")
  return id
}

function queryText(v: unknown, max = 255): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined
}

/* ── Foydalanuvchi tomoni ───────────────────────────────────────────── */

router.get("/my", wrap(async (req, res) => {
  res.json({ success: true, data: await listMySurveys(respondentOf(req)) })
}))

router.get("/my/pending-count", wrap(async (req, res) => {
  res.json({ success: true, count: await pendingCount(respondentOf(req)) })
}))

router.get("/:id(\\d+)", wrap(async (req, res) => {
  res.json({ success: true, data: await getSurveyForRespondent(idParam(req), respondentOf(req)) })
}))

router.post("/:id(\\d+)/submit", wrap(async (req, res) => {
  await submitSurveyResponse(idParam(req), respondentOf(req), req.body?.answers)
  res.json({ success: true, message: "Javobingiz qabul qilindi. Rahmat!" })
}))

/* ── Boshqaruv (admin / dekanat) ────────────────────────────────────── */

const manage = Router()

/** Boshqaruvchini aniqlaydi: admin — cheklovsiz, dekan — o'z fakultetlari bilan */
async function loadManager(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const role = await getUserAdminRole(req)
    if (!role) {
      res.status(403).json({ success: false, message: "So'rovnomalarni faqat admin yoki dekanat boshqaradi" })
      return
    }
    const hemisId = hemisIdOf(req)
    const manager: SurveyManager = {
      hemisId,
      name: String(req.user?.fullName ?? req.user?.username ?? ""),
      role,
      faculties: role === "admin" ? null : await getDeanFaculties(hemisId),
    }
    res.locals.surveyManager = manager
    next()
  } catch (err) {
    console.error("[surveys] manager:", (err as { message?: string })?.message ?? err)
    res.status(500).json({ success: false, message: "Server xatosi" })
  }
}

const mgr = (res: Response) => res.locals.surveyManager as SurveyManager

manage.use(loadManager)

manage.get("/me", wrap(async (_req, res) => {
  const m = mgr(res)
  const perm = async (action: "view" | "create" | "edit" | "delete") => m.role === "admin" || (await hasPermission(m.role, "surveys", action))
  res.json({
    success: true,
    data: {
      role: m.role,
      faculties: m.faculties,
      canView: await perm("view"),
      canCreate: await perm("create"),
      canEdit: await perm("edit"),
      canDelete: await perm("delete"),
      surveyTypes: SURVEY_TYPES,
    },
  })
}))

manage.get("/", requirePermission("surveys", "view"), wrap(async (_req, res) => {
  const list = await listManagedSurveys(mgr(res))
  res.json({ success: true, data: list, summary: summarizeSurveys(list) })
}))

manage.get("/options", requirePermission("surveys", "view"), wrap(async (_req, res) => {
  res.json({ success: true, data: { ...(await audienceOptions(mgr(res).faculties)), surveyTypes: SURVEY_TYPES } })
}))

manage.post("/preview", requirePermission("surveys", "view"), wrap(async (req, res) => {
  res.json({ success: true, data: await previewAudience(normalizeTargets(req.body?.targets), mgr(res).faculties) })
}))

/* Dekanat fakultetlari — faqat to'liq admin biriktiradi */
manage.get("/deans", requireFullAdmin, wrap(async (_req, res) => {
  const [deans, faculties] = await Promise.all([listDeansWithFaculties(), allFaculties()])
  res.json({ success: true, data: { deans, faculties } })
}))

manage.put("/deans/:hemisId/faculties", requireFullAdmin, wrap(async (req, res) => {
  const hemisId = String(req.params.hemisId ?? "").trim()
  if (!hemisId || hemisId.length > 255) throw new SurveyError(400, "ID noto'g'ri")
  const deans = await listDeansWithFaculties()
  if (!deans.some((d) => d.hemisId === hemisId)) throw new SurveyError(404, "Bu foydalanuvchi dekanat roliga ega emas")
  const known = new Set(await allFaculties())
  const raw: unknown[] = Array.isArray(req.body?.faculties) ? req.body.faculties : []
  const faculties = [...new Set(raw.map((f) => String(f).trim()).filter((f) => known.has(f)))]
  await setDeanFaculties(hemisId, faculties)
  void logAudit(req, "survey.dean_faculties", "surveys", hemisId, { faculties })
  res.json({ success: true, data: { hemisId, faculties } })
}))

manage.post("/", requirePermission("surveys", "create"), wrap(async (req, res) => {
  const publish = req.body?.publish === true
  const input = validateSurveyInput(req.body, { publish })
  const id = await createSurvey(input, mgr(res))
  let participants: number | null = null
  if (publish) {
    try {
      participants = (await publishSurvey(id, mgr(res))).participants
      void runSurveyNotifications(new Date(), id)
    } catch (err) {
      // Qoralama saqlandi, e'lon qilinmadi — sababini qaytaramiz
      if (err instanceof SurveyError) {
        res.status(201).json({ success: true, data: { id, published: false }, message: `Qoralama saqlandi, lekin e'lon qilinmadi: ${err.message}` })
        return
      }
      throw err
    }
  }
  void logAudit(req, publish ? "survey.create_publish" : "survey.create", "surveys", String(id), { title: input.title, participants })
  res.status(201).json({ success: true, data: { id, published: publish, participants } })
}))

manage.get("/:id(\\d+)", requirePermission("surveys", "view"), wrap(async (req, res) => {
  res.json({ success: true, data: await getSurveyDetail(idParam(req), mgr(res)) })
}))

manage.put("/:id(\\d+)", requirePermission("surveys", "edit"), wrap(async (req, res) => {
  const id = idParam(req)
  const current = await getSurveyDetail(id, mgr(res))
  const publish = req.body?.publish === true && current.status === "draft"
  const input = validateSurveyInput(req.body, { publish: publish || current.status === "published" })
  await updateSurvey(id, input, mgr(res))
  let participants: number | null = null
  if (publish) {
    participants = (await publishSurvey(id, mgr(res))).participants
    void runSurveyNotifications(new Date(), id)
  }
  void logAudit(req, publish ? "survey.update_publish" : "survey.update", "surveys", String(id), { title: input.title, participants })
  res.json({ success: true, data: { id, published: publish || current.status === "published", participants } })
}))

manage.post("/:id(\\d+)/publish", requirePermission("surveys", "edit"), wrap(async (req, res) => {
  const id = idParam(req)
  const result = await publishSurvey(id, mgr(res))
  void runSurveyNotifications(new Date(), id)
  void logAudit(req, "survey.publish", "surveys", String(id), result)
  res.json({ success: true, data: result })
}))

manage.patch("/:id(\\d+)/active", requirePermission("surveys", "edit"), wrap(async (req, res) => {
  const id = idParam(req)
  const active = req.body?.active === true
  await setSurveyActive(id, active, mgr(res))
  if (active) void runSurveyNotifications(new Date(), id)
  void logAudit(req, active ? "survey.resume" : "survey.pause", "surveys", String(id))
  res.json({ success: true })
}))

manage.patch("/:id(\\d+)/archive", requirePermission("surveys", "edit"), wrap(async (req, res) => {
  const id = idParam(req)
  const archived = req.body?.archived !== false
  await setSurveyArchived(id, archived, mgr(res))
  void logAudit(req, archived ? "survey.archive" : "survey.unarchive", "surveys", String(id))
  res.json({ success: true })
}))

manage.post("/:id(\\d+)/duplicate", requirePermission("surveys", "create"), wrap(async (req, res) => {
  const id = await duplicateSurvey(idParam(req), mgr(res))
  void logAudit(req, "survey.duplicate", "surveys", String(id), { from: req.params.id })
  res.status(201).json({ success: true, data: { id } })
}))

manage.delete("/:id(\\d+)", requirePermission("surveys", "delete"), wrap(async (req, res) => {
  const id = idParam(req)
  await deleteSurvey(id, mgr(res), req.query.force === "1")
  void logAudit(req, "survey.delete", "surveys", String(id), { force: req.query.force === "1" })
  res.json({ success: true })
}))

manage.get("/:id(\\d+)/results", requirePermission("surveys", "view"), wrap(async (req, res) => {
  const segment = {
    role: queryText(req.query.role, 20),
    faculty: queryText(req.query.faculty),
    specialty: queryText(req.query.specialty),
    course: queryText(req.query.course, 60),
    group: queryText(req.query.group, 120),
  }
  res.json({ success: true, data: await getSurveyResults(idParam(req), mgr(res), segment) })
}))

manage.get("/:id(\\d+)/participants", requirePermission("surveys", "view"), wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500)
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0)
  const data = await listParticipants(idParam(req), mgr(res), {
    status: queryText(req.query.status, 20),
    search: queryText(req.query.q, 100),
    faculty: queryText(req.query.faculty),
    course: queryText(req.query.course, 60),
    group: queryText(req.query.group),
    role: queryText(req.query.role, 20),
    limit,
    offset,
  })
  res.json({ success: true, ...data })
}))

manage.get("/:id(\\d+)/export", requirePermission("surveys", "view"), wrap(async (req, res) => {
  const id = idParam(req)
  const data = await exportSurvey(id, mgr(res))
  void logAudit(req, "survey.export", "surveys", String(id))
  res.json({ success: true, data })
}))

router.use("/manage", manage)

export default router
