import { Router, Response } from "express"
import type mysql from "mysql2/promise"
import axios, { AxiosError } from "axios"
import jwt from "jsonwebtoken"
import archiver from "archiver"
import { randomBytes } from "crypto"
import fs from "fs"
import path from "path"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { localResourcesAsHemisResources } from "../services/localResourceStore"
import { withHemisCache, upsertHemisUser, pool } from "../services/db"
import { recordPlatformSession } from "../services/attendanceStore"
import {
  teacherUserId,
  studentUserId,
  weekDayName,
  toMysqlDateOnly,
  syncTeacherGroupsAndSchedule,
  replaceTeacherSubjects,
  submissionUploadsDir,
  sanitizeFilename,
  type SyncedGroup,
  type TeacherScheduleInput,
} from "../services/teachingStore"

const router = Router()
const HEMIS_BASE     = normalizeRestBase(process.env.HEMIS_BASE || process.env.HEMIS_STUDENT_URL || "https://student.sies.uz/rest")
const HEMIS          = normalizeRestBase(process.env.HEMIS_STUDENT_URL || HEMIS_BASE)
const HEMIS_EMPLOYEE = normalizeRestBase(process.env.HEMIS_EMPLOYEE_URL || "https://hemis.sies.uz/rest")
const HEMIS_TUTOR    = normalizeRestBase(process.env.HEMIS_TUTOR_URL || process.env.HEMIS_TUTOR_BASE || HEMIS_BASE)
const HEMIS_EMPLOYEE_LOGIN_BASES = Array.from(new Set([
  HEMIS_TUTOR,
  HEMIS_EMPLOYEE,
  HEMIS_BASE,
  "https://hemis.sies.uz/rest",
  "https://student.sies.uz/rest",
])).filter(Boolean)
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000"
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`
const HEMIS_OAUTH_CLIENT_ID =
  (process.env.HEMIS_OAUTH_CLIENT_ID ||
    process.env.HEMIS_CLIENT_ID ||
    process.env.Client_ID ||
    process.env.CLIENT_ID ||
    "").trim()
const HEMIS_OAUTH_EMPLOYEE_CLIENT_ID =
  (process.env.HEMIS_OAUTH_EMPLOYEE_CLIENT_ID || HEMIS_OAUTH_CLIENT_ID).trim()
const HEMIS_OAUTH_TUTOR_CLIENT_ID =
  (process.env.HEMIS_OAUTH_TUTOR_CLIENT_ID || HEMIS_OAUTH_EMPLOYEE_CLIENT_ID || HEMIS_OAUTH_CLIENT_ID).trim()
const HEMIS_OAUTH_STUDENT_CLIENT_ID =
  (process.env.HEMIS_OAUTH_STUDENT_CLIENT_ID || HEMIS_OAUTH_CLIENT_ID).trim()
const HEMIS_OAUTH_CLIENT_SECRET =
  (process.env.HEMIS_OAUTH_CLIENT_SECRET ||
    process.env.HEMIS_CLIENT_CODE ||
    process.env.Client_Code ||
    process.env.CLIENT_CODE ||
    "").trim()
const HEMIS_OAUTH_EMPLOYEE_CLIENT_SECRET =
  (process.env.HEMIS_OAUTH_EMPLOYEE_CLIENT_SECRET || HEMIS_OAUTH_CLIENT_SECRET).trim()
const HEMIS_OAUTH_TUTOR_CLIENT_SECRET =
  (process.env.HEMIS_OAUTH_TUTOR_CLIENT_SECRET || HEMIS_OAUTH_EMPLOYEE_CLIENT_SECRET || HEMIS_OAUTH_CLIENT_SECRET).trim()
const HEMIS_OAUTH_STUDENT_CLIENT_SECRET =
  (process.env.HEMIS_OAUTH_STUDENT_CLIENT_SECRET || HEMIS_OAUTH_CLIENT_SECRET).trim()
const HEMIS_OAUTH_REDIRECT_URI =
  (process.env.HEMIS_OAUTH_REDIRECT_URI ||
    `${stripTrailingSlash(FRONTEND_URL)}/login/oauth/callback`).trim()
const HEMIS_OAUTH_EMPLOYEE_REDIRECT_URI =
  (process.env.HEMIS_OAUTH_EMPLOYEE_REDIRECT_URI || HEMIS_OAUTH_REDIRECT_URI).trim()
const HEMIS_OAUTH_TUTOR_REDIRECT_URI =
  (process.env.HEMIS_OAUTH_TUTOR_REDIRECT_URI || HEMIS_OAUTH_EMPLOYEE_REDIRECT_URI || HEMIS_OAUTH_REDIRECT_URI).trim()
const HEMIS_OAUTH_STUDENT_REDIRECT_URI =
  (process.env.HEMIS_OAUTH_STUDENT_REDIRECT_URI || HEMIS_OAUTH_REDIRECT_URI).trim()
const HEMIS_OAUTH_STUDENT_BASE =
  stripTrailingSlash((process.env.HEMIS_OAUTH_STUDENT_BASE || webBaseFromRest(HEMIS_BASE)).trim())
const HEMIS_OAUTH_EMPLOYEE_BASE =
  stripTrailingSlash((process.env.HEMIS_OAUTH_EMPLOYEE_BASE || webBaseFromRest(HEMIS_EMPLOYEE)).trim())
const HEMIS_OAUTH_TUTOR_BASE =
  stripTrailingSlash((process.env.HEMIS_OAUTH_TUTOR_BASE || HEMIS_OAUTH_EMPLOYEE_BASE).trim())
const HEMIS_OAUTH_AUTO_BASE =
  stripTrailingSlash((process.env.HEMIS_OAUTH_AUTO_BASE || HEMIS_OAUTH_EMPLOYEE_BASE).trim())
const HEMIS_OAUTH_EMPLOYEE_FIELDS = csvList(process.env.HEMIS_OAUTH_EMPLOYEE_FIELDS, [
  "id",
  "uuid",
  "employee_id_number",
  "university_id",
  "type",
  "roles",
  "name",
  "firstname",
  "surname",
  "patronymic",
  "login",
  "picture",
  "email",
  "phone",
  "birth_date",
])
const HEMIS_OAUTH_STUDENT_FIELDS = csvList(process.env.HEMIS_OAUTH_STUDENT_FIELDS, [
  "id",
  "uuid",
  "student_id_number",
  "university_id",
  "type",
  "roles",
  "name",
  "firstname",
  "surname",
  "patronymic",
  "login",
  "picture",
  "email",
  "phone",
  "birth_date",
  "student_api_token",
  "groups",
])
const HEMIS_TOKEN    = process.env.HEMIS_TOKEN || "wvCCF_aTdTuD9LrhP0EUgWSdQ1wEGzlZ"
const HEMIS_TUTOR_RECAPTCHA = process.env.HEMIS_TUTOR_RECAPTCHA || ""
const EMPLOYEE_TYPES = (process.env.EMPLOYEE_TYPES || "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean)
const JWT_SECRET = process.env.JWT_SECRET || "secret"

/* ── Cache helpers ──────────────────────────────────────────────────── */
const TTL_1H  = 60 * 60 * 1000
const TTL_4H  = 4 * 60 * 60 * 1000
const TTL_24H = 24 * 60 * 60 * 1000

function reqUserId(req: AuthRequest): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.username ?? "anon")
}

async function saveUserToDb(token: string, role: string) {
  try {
    const decoded = jwt.decode(token) as Record<string, unknown> | null
    if (!decoded) return
    const hemisId = String(decoded.userId ?? decoded.id ?? decoded.username ?? "")
    if (!hemisId) return
    // Employee bo'lsa, raqamli teacher_user_id ni ham saqlaymiz
    const teacherNumId = role === "employee" ? teacherUserId(decoded as unknown as AuthRequest["user"]) : null
    await upsertHemisUser({
      hemis_id:       hemisId,
      role,
      username:       String(decoded.username ?? decoded.fullName ?? ""),
      full_name:      String(decoded.fullName  ?? decoded.username ?? ""),
      hemis_token:    String(decoded.hemisToken ?? ""),
      profile:        decoded.employeeProfile ? JSON.stringify(decoded.employeeProfile) : undefined,
      teacher_user_id: teacherNumId,
    })
  } catch { /* DB xatosini e'tiborsiz qoldiramiz — asosiy login ishlaversin */ }
}

/** HEMIS dars jadvali elementlaridan guruh va jadval qatorlarini ajratib oladi. */
function extractSyncDataFromSchedule(items: unknown[]): { groups: SyncedGroup[]; schedule: TeacherScheduleInput[] } {
  const groupMap = new Map<number, SyncedGroup>()
  const schedule: TeacherScheduleInput[] = []

  for (const raw of items) {
    const item  = asRecord(raw)
    const group = asRecord(item.group ?? item._group)
    const groupId   = numberValue(group.id, group.group_id, group.groupId, group.code, item._group)
    const groupName = textValue(group.name, group.code)
    if (groupId !== null && groupName && !groupMap.has(groupId)) {
      groupMap.set(groupId, { id: groupId, name: groupName })
    }

    const subjectName = textValue(asRecord(item.subject).name, item.subject_name) || "Fan"
    const lessonPair  = asRecord(item.lessonPair ?? item.lesson_pair)
    const auditorium  = asRecord(item.auditorium ?? item.room)
    const lessonDateValue = numberValue(item.lesson_date, item.lessonDate)
    const lessonDate = lessonDateValue !== null ? new Date(lessonDateValue * 1000) : null

    schedule.push({
      groupId,
      subjectName,
      weekDay:    lessonDate ? weekDayName(lessonDate) : textValue(item.week_day, item.weekDay) ?? null,
      lessonDate: lessonDate ? toMysqlDateOnly(lessonDate) : null,
      startTime:  textValue(lessonPair.start_time, lessonPair.startTime, item.start_time) ?? null,
      endTime:    textValue(lessonPair.end_time, lessonPair.endTime, item.end_time) ?? null,
      room:       textValue(auditorium.name, item.room) ?? null,
      raw: item,
    })
  }

  return { groups: Array.from(groupMap.values()), schedule }
}

/**
 * Tutor API orqali o'qituvchining HEMIS'da o'ziga biriktirilgan guruhlar
 * ro'yxatini oladi. Avval /ver1/tutor/profile/groups (tyutorga tegishli
 * guruhlar), so'ng /ver1/tutor/group/list sinab ko'riladi. Bu so'rovlar
 * o'qituvchining o'z `hemisToken`i bilan amalga oshiriladi va _employee
 * filtriga bog'liq emas.
 */
async function fetchTutorGroupsFrom(endpoint: string, base: string, token: string): Promise<SyncedGroup[]> {
  try {
    const data = await hemisGet(base, endpoint, token)
    const result = asRecord(unwrapHemisData(data))
    const groups = Array.isArray(result.groups) ? result.groups : []
    return groups
      .map((item) => {
        const group = asRecord(item)
        const id = numberValue(group.id)
        const name = textValue(group.name)
        return id !== null && name ? { id, name } : null
      })
      .filter((g): g is SyncedGroup => g !== null)
  } catch (err) {
    console.warn(`[hemis] ${endpoint} olishda xato:`, extractMessage(err))
    return []
  }
}

async function fetchTutorGroups(user?: AuthRequest["user"]): Promise<SyncedGroup[]> {
  const token = user?.hemisToken
  if (!token) return []
  const base = user?.employeeHemisBase || HEMIS_EMPLOYEE

  const fromProfile = await fetchTutorGroupsFrom("/ver1/tutor/profile/groups", base, token)
  if (fromProfile.length) return fromProfile

  return fetchTutorGroupsFrom("/ver1/tutor/group/list", base, token)
}

/**
 * O'qituvchiga HEMIS'da biriktirilgan guruhlar va dars jadvalini bir martalik
 * so'rov bilan olib, o'z bazamizga yozadi (login paytida + qo'lda "yangilash").
 * Bu yerdan boshqa hech qanday HEMIS resursi (fan resurslari va h.k.) tortib olinmaydi.
 */
export async function syncTeacherFromHemis(token: string) {
  try {
    const decoded = jwt.decode(token)
    if (!decoded || typeof decoded !== "object") return
    const user = decoded as AuthRequest["user"]
    if (!user || user.role !== "employee") return

    const userId = teacherUserId(user)

    // Asosiy manba: Tutor API'ning o'z guruhlar ro'yxati
    // (/ver1/tutor/profile/groups, keyin /ver1/tutor/group/list) —
    // o'qituvchining HEMIS'da unga biriktirilgan guruhlarini
    // to'g'ridan-to'g'ri qaytaradi, _employee filtriga bog'liq emas.
    let groups = await fetchTutorGroups(user)

    // Dars jadvali (va, agar tutor/group/list bo'sh bo'lsa, undan guruhlar)
    // _employee aniqlangandagina so'raladi — aks holda /v1/data/schedule-list
    // cheklovsiz (butun universitet bo'yicha) natija qaytarib, "hamma
    // guruhlar" biriktirilib qolishiga sabab bo'ladi.
    let schedule: TeacherScheduleInput[] = []
    if (employeeIdFromUser(user)) {
      const items = await employeeDataAllItems("/v1/data/schedule-list", { limit: "200" }, user)
      const extracted = extractSyncDataFromSchedule(Array.isArray(items) ? items : [])
      schedule = extracted.schedule
      if (!groups.length) groups = extracted.groups
    }

    // Hech qayerdan guruh topilmasa, profilga biriktirilgan guruhlarni
    // (agar bo'lsa) so'nggi chora sifatida ishlatamiz.
    if (!groups.length) {
      const profile = asRecord(user.employeeProfile)
      groups = resolveEmployeeGroupIds(profile).map((id) => ({ id, name: `Guruh #${id}` }))
    }

    await syncTeacherGroupsAndSchedule(userId, groups, schedule)

    // O'qituvchi haqiqiy ismi bilan sessiya yozish (admin panel uchun nom manbayi)
    const fullName = textValue(user.fullName, (user as unknown as Record<string, unknown>).name as string)
    if (fullName && userId > 0) {
      try {
        void recordPlatformSession(userId, fullName, null, "employee")
        await pool.query(
          `UPDATE lms_platform_sessions SET full_name = ?
           WHERE user_id = ? AND role = 'employee' AND (full_name IS NULL OR full_name = '' OR full_name NOT LIKE '% %')`,
          [fullName, userId]
        )
      } catch { /* sessiya yozilmasa ham kirish ishlayversin */ }
    }

    // Agar o'qituvchi endi to'g'ri raqamli ID olgan bo'lsa (9001 emas),
    // avvalgi 9001 fallback ostida saqlangan kontentni yangi ID ga ko'chirish
    if (userId !== 9001 && userId > 0) {
      try {
        await pool.query(`UPDATE lms_teacher_content  SET teacher_user_id     = ? WHERE teacher_user_id     = 9001`, [userId])
        await pool.query(`UPDATE lms_teacher_groups   SET user_id             = ? WHERE user_id             = 9001`, [userId])
        await pool.query(`UPDATE lms_teacher_subjects SET user_id             = ? WHERE user_id             = 9001`, [userId])
        await pool.query(`UPDATE lms_teacher_schedule SET teacher_user_id     = ? WHERE teacher_user_id     = 9001`, [userId])
        await pool.query(`UPDATE lms_meetings         SET created_by_user_id  = ? WHERE created_by_user_id  = 9001`, [userId])
        await pool.query(`UPDATE lms_platform_sessions SET user_id            = ? WHERE user_id             = 9001 AND role = 'employee'`, [userId])
      } catch { /* migratsiya xatosi — asosiy login ishlayversin */ }
    }
  } catch (err) {
    console.warn("[hemis] o'qituvchi guruh/jadvalini sinxronlashda xato:", extractMessage(err))
  }
}

/**
 * Berilgan guruhning HEMIS'dagi talabalar ro'yxatini qaytaradi (davomat moduli uchun).
 * Admin token (`HEMIS_TOKEN`) orqali `/v1/data/student-list?_group=` so'raladi.
 */
export interface GroupRosterStudent {
  hemisId: number
  fullName: string
  studentIdNumber: string | null
}

/**
 * "Kurs topshiriqlari" kabi tutor sinxronizatsiyasiga kirmaydigan guruhlar uchun -
 * o'qituvchi ushbu guruhda haqiqatan ham dars beradimi, HEMIS
 * /v1/data/curriculum-subject-teacher-list orqali tekshiradi.
 */
export async function employeeTeachesGroup(groupId: number, user?: AuthRequest["user"]): Promise<boolean> {
  const employeeId = employeeIdFromUser(user)
  if (!employeeId) return false
  try {
    const items = await employeeDataAllItems("/v1/data/curriculum-subject-teacher-list", { _employee: employeeId, limit: "200" }, user)
    return items.some((item) => numberValue(asRecord(item)._group) === groupId)
  } catch {
    return false
  }
}

export async function fetchGroupRoster(groupId: number): Promise<GroupRosterStudent[]> {
  const items = await employeeDataItems("/v1/data/student-list", { _group: String(groupId), limit: "200" })
  const list = Array.isArray(items) ? items : normalizeDataItems(items)
  return list
    .map((item) => {
      const record = asRecord(item)
      return {
        hemisId: numberValue(record.id) ?? 0,
        fullName: textValue(record.full_name, record.name) || "Talaba",
        studentIdNumber: textValue(record.student_id_number) || null,
      }
    })
    .filter((s) => s.hemisId > 0)
}


/* ── helpers ──────────────────────────────────────────────────────── */
function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function normalizeRestBase(value: string) {
  return stripTrailingSlash(value.trim()).replace(/\/v1$/i, "")
}

function webBaseFromRest(value: string) {
  return stripTrailingSlash(value).replace(/\/rest(?:\/v1)?$/i, "")
}

function csvList(value: string | undefined, fallback: string[]) {
  const items = (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  return items.length ? items : fallback
}

/* HEMIS ba'zida Uzbek apostrof `ʻ` ni noto'g'ri encoding bilan yuboradi.
   Bu funksiya matnni tiklaydi: â+box → ' */
function fixEncoding(text: string): string {
  if (!text) return text
  return text
    // UTF-8 baytlari Latin-1 sifatida o'qilganda hosil bo'ladigan qatorlar
    .replace(/â/g, "'")   // â€™  → '
    .replace(/â/g, "'")   // â€˜  → '
    .replace(/â/g, '"')   // â€œ  → "
    .replace(/â/g, '"')   // â€   → "
    // Uzbek maxsus belgilari
    .replace(/[ʻʼ]/g, "'")        // ʻ ʼ  → '
    .replace(/[‘’]/g, "'")        // ' '  → '
    .replace(/[“”]/g, '"')        // " "  → "
    .normalize("NFC")
}

function fixName(value: unknown): string {
  return fixEncoding(String(value ?? "").trim())
}

function extractMessage(err: unknown, fallback = "Xatolik yuz berdi"): string {
  const e = err as AxiosError<{ message?: string; errors?: unknown }>
  const hemisMsg = e?.response?.data?.message
  if (hemisMsg && hemisMsg.trim()) return hemisMsg.trim()
  if (e?.response?.status === 401) return "Login yoki parol noto'g'ri"
  if (e?.response?.status === 403) return "Ruxsat yo'q"
  if (e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND") return "HEMIS serveriga ulanib bo'lmadi"
  if (e instanceof Error && e.message && !e.message.includes("status code")) return e.message
  return fallback
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function oauthCodeValue(value: unknown) {
  const code = textValue(value)
  // Some HEMIS deployments return OAuth codes with "+" characters. If the
  // browser decodes a query string with URLSearchParams, raw "+" becomes space.
  return code ? code.replace(/ /g, "+") : undefined
}

function numberValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return null
}

function normalizeGroupName(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
}

function resolveStudentGroupId(profile: Record<string, unknown>) {
  const group = asRecord(profile.group)
  const groupName = normalizeGroupName(textValue(group.name, profile.group_name))
  const groupCode = normalizeGroupName(textValue(group.code, profile.group_code))

  if (groupName === "BH-M-425" || groupCode === "BH-M-425") return 425

  return numberValue(
    profile.group_id,
    profile.groupId,
    group.id,
    group.code
  )
}

function parseIdList(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : []
  return values
    .map((item) => numberValue(item))
    .filter((item): item is number => item !== null)
}

function resolveEmployeeGroupIds(profile: Record<string, unknown>) {
  const direct = [
    ...parseIdList(profile.teacherGroupIds),
    ...parseIdList(profile.groupIds),
    ...parseIdList(process.env.EMPLOYEE_GROUP_IDS),
  ]

  const groups = Array.isArray(profile.groups) ? profile.groups : []
  const groupIds = groups
    .map((item) => {
      const group = asRecord(item)
      const groupName = normalizeGroupName(textValue(group.name, group.code))
      if (groupName === "BH-M-425") return 425
      return numberValue(group.id, group.group_id, group.groupId, group.code)
    })
    .filter((item): item is number => item !== null)

  // E'tibor: bu yerda demo/standart guruhga (masalan 425) qaytarib bo'lmaydi —
  // aks holda haqiqiy o'qituvchining guruhlar ro'yxatiga begona "demo" guruh
  // qo'shilib qoladi (lms_teacher_groups orqali doimiy saqlanadi).
  return Array.from(new Set([...direct, ...groupIds]))
}

function employeeTypeAllowed(profile: Record<string, unknown>) {
  if (!EMPLOYEE_TYPES.length) return true
  const employeeType = asRecord(profile.employeeType)
  const staffPosition = asRecord(profile.staffPosition)
  const values = [
    profile.employee_type,
    employeeType.id,
    employeeType.code,
    employeeType.name,
    staffPosition.id,
    staffPosition.code,
    staffPosition.name,
  ]
    .map((item) => textValue(item)?.toLowerCase())
    .filter(Boolean)

  return values.some((value) => {
    if (!value) return false
    if (EMPLOYEE_TYPES.includes(value)) return true
    if (EMPLOYEE_TYPES.includes("teacher")) {
      const normalized = value
        .replace(/['`’]/g, "")
        .replace(/ў/g, "o")
        .replace(/қ/g, "q")
      return (
        normalized.includes("oqituvchi") ||
        normalized.includes("teacher") ||
        normalized.includes("professor") ||
        normalized.includes("dotsent")
      )
    }
    return false
  })
}


function signStudentToken(hemisToken: string, login: string, profile: Record<string, unknown>, studentAuthMode: "password" | "oauth" = "password") {
  const fullName = fixName(textValue(
    profile.full_name,
    profile.fullName,
    profile.name,
    profile.short_name,
    login
  ) ?? login)
  const groupId = resolveStudentGroupId(profile)
  const userId = numberValue(profile.id, profile.student_id, profile.meta_id) ?? undefined

  return jwt.sign(
    {
      ...(userId ? { id: userId, userId } : {}),
      hemisToken,
      role: "student",
      username: fullName || login,
      fullName,
      groupId,
      studentAuthMode,
    },
    JWT_SECRET,
    { expiresIn: "2d" }
  )
}

function signEmployeeToken(
  _employee: null,
  hemisToken: string,
  login: string,
  profile: Record<string, unknown>,
  employeeHemisBase = HEMIS_EMPLOYEE,
  employeeProfilePath = "/v1/account/me",
  employeeAuthMode: "password" | "tutor" | "oauth" = "password"
) {
  const fullName = fixName(textValue(
    profile.full_name,
    profile.fullName,
    profile.name,
    profile.short_name,
    login
  ) ?? login)
  const userId = numberValue(profile.id, profile.meta_id, profile.employee_id_number) ?? undefined
  const teacherGroupIds = resolveEmployeeGroupIds(profile)

  return jwt.sign(
    {
      ...(userId ? { id: userId, userId } : {}),
      hemisToken,
      role: "employee",
      username: fullName || login,
      fullName,
      isEmployee: true,
      employeeHemisBase,
      employeeProfilePath,
      employeeAuthMode,
      teacherGroupIds,
      employeeType: textValue(
        asRecord(profile.employeeType).name,
        asRecord(profile.staffPosition).name,
        "O'qituvchi"
      ),
    },
    JWT_SECRET,
    { expiresIn: "2d" }
  )
}

// Send both Bearer header (Student API /v1/education/*) AND ?access-token= (older endpoints)
async function hemisGet<T = unknown>(
  base: string,
  path: string,
  token: string,
  params: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${base}${path}`)
  url.searchParams.set("access-token", token)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const res = await axios.get<T>(url.toString(), {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  })
  return res.data
}

async function tutorPasswordLogin(base: string, login: string, password: string) {
  const withCaptcha = (payload: Record<string, string>) => ({
    ...payload,
    ...(HEMIS_TUTOR_RECAPTCHA ? { reCaptcha: HEMIS_TUTOR_RECAPTCHA } : {}),
  })
  const payloads = [
    withCaptcha({ login, password }),
    withCaptcha({ username: login, password }),
  ]
  const errors: string[] = []

  for (const payload of payloads) {
    try {
      const { data } = await axios.post<{ success?: boolean; data?: { token?: string; access_token?: string }; token?: string; access_token?: string; message?: string }>(
        `${base}/ver1/tutor/auth/login`,
        payload,
        { headers: { "Content-Type": "application/json", Accept: "application/json" } }
      )
      const hemisToken = data?.data?.token || data?.data?.access_token || data?.token || data?.access_token
      if (!hemisToken) {
        throw Object.assign(new Error(data?.message?.trim() || "Token qaytmadi"), { status: 401, data })
      }
      return hemisToken
    } catch (err) {
      errors.push(extractMessage(err, "Login yoki parol noto'g'ri"))
    }
  }

  throw new Error(errors[0] || "Login yoki parol noto'g'ri")
}

type OAuthRole = "student" | "employee" | "tutor" | "auto"
type OAuthStateEntry = { role: OAuthRole; redirectUri: string; expiresAt: number; expectedLogin?: string }
type OAuthStatePayload = {
  purpose?: string
  role?: string
  redirectUri?: string
  expectedLogin?: string
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const oauthStates = new Map<string, OAuthStateEntry>()

function normalizeOAuthRole(value: unknown): OAuthRole | null {
  return value === "student" || value === "employee" || value === "tutor" || value === "auto" ? value : null
}

function oauthBaseForRole(role: OAuthRole) {
  if (role === "auto") return HEMIS_OAUTH_AUTO_BASE
  if (role === "tutor") return HEMIS_OAUTH_TUTOR_BASE
  return role === "student" ? HEMIS_OAUTH_STUDENT_BASE : HEMIS_OAUTH_EMPLOYEE_BASE
}

function oauthClientIdForRole(role: OAuthRole) {
  if (role === "student") return HEMIS_OAUTH_STUDENT_CLIENT_ID
  if (role === "tutor") return HEMIS_OAUTH_TUTOR_CLIENT_ID
  return HEMIS_OAUTH_EMPLOYEE_CLIENT_ID || HEMIS_OAUTH_CLIENT_ID
}

function oauthClientSecretForRole(role: OAuthRole) {
  if (role === "student") return HEMIS_OAUTH_STUDENT_CLIENT_SECRET
  if (role === "tutor") return HEMIS_OAUTH_TUTOR_CLIENT_SECRET
  return HEMIS_OAUTH_EMPLOYEE_CLIENT_SECRET || HEMIS_OAUTH_CLIENT_SECRET
}

function configuredRedirectUriForRole(role: OAuthRole) {
  if (role === "student") return HEMIS_OAUTH_STUDENT_REDIRECT_URI
  if (role === "tutor") return HEMIS_OAUTH_TUTOR_REDIRECT_URI
  return HEMIS_OAUTH_EMPLOYEE_REDIRECT_URI || HEMIS_OAUTH_REDIRECT_URI
}

function normalizeConfiguredRedirectUri(role: OAuthRole = "employee") {
  try {
    const url = new URL(configuredRedirectUriForRole(role))
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return `${stripTrailingSlash(FRONTEND_URL)}/login/oauth/callback`
    }
    return url.toString()
  } catch {
    return `${stripTrailingSlash(FRONTEND_URL)}/login/oauth/callback`
  }
}

function normalizeRedirectUri(_value?: unknown, role: OAuthRole = "employee") {
  return normalizeConfiguredRedirectUri(role)
}

function serverOAuthRedirectUri(role: OAuthRole) {
  return `${stripTrailingSlash(BACKEND_URL)}/api/hemis/oauth/${role}`
}

function configuredOAuthRedirectUri(role: OAuthRole) {
  const redirectUri = normalizeConfiguredRedirectUri(role)
  if (redirectUri) return redirectUri
  return serverOAuthRedirectUri(role)
}

function cleanupExpiredOAuthStates() {
  const now = Date.now()
  for (const [state, entry] of oauthStates) {
    if (entry.expiresAt <= now) oauthStates.delete(state)
  }
}

function createOAuthState(role: OAuthRole, redirectUri: string, expectedLogin?: string) {
  return jwt.sign(
    {
      purpose: "hemis-oauth",
      role,
      redirectUri,
      ...(expectedLogin ? { expectedLogin } : {}),
      nonce: randomBytes(8).toString("hex"),
    },
    JWT_SECRET,
    { expiresIn: Math.floor(OAUTH_STATE_TTL_MS / 1000) }
  )
}

function buildOAuthAuthorizeUrl(role: OAuthRole, redirectUri: string, state: string) {
  const clientId = oauthClientIdForRole(role)
  const url = new URL(`${oauthBaseForRole(role)}/oauth/authorize`)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("approval_prompt", "force")
  url.searchParams.set("prompt", "login")
  url.searchParams.set("max_age", "0")
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("state", state)
  return url
}

function readOAuthState(state: unknown, role: OAuthRole, redirectUri: string): OAuthStatePayload | null {
  if (!state || typeof state !== "string") return null
  cleanupExpiredOAuthStates()
  const entry = oauthStates.get(state)
  if (entry) {
    oauthStates.delete(state)
    if (entry.role === role && entry.redirectUri === redirectUri && entry.expiresAt > Date.now()) {
      return {
        purpose: "hemis-oauth",
        role: entry.role,
        redirectUri: entry.redirectUri,
        expectedLogin: entry.expectedLogin,
      }
    }
    return null
  }

  // Backward compatibility for OAuth attempts started before the short-state
  // change was deployed.
  try {
    const decoded = jwt.verify(state, JWT_SECRET) as OAuthStatePayload
    if (decoded.purpose === "hemis-oauth" && decoded.role === role && decoded.redirectUri === redirectUri) {
      return decoded
    }
    return null
  } catch {
    return null
  }
}

function verifyOAuthState(state: unknown, role: OAuthRole, redirectUri: string) {
  return Boolean(readOAuthState(state, role, redirectUri))
}

async function hemisOAuthAccessToken(role: OAuthRole, code: string, redirectUri: string) {
  const clientId = oauthClientIdForRole(role)
  const clientSecret = oauthClientSecretForRole(role)
  if (!clientId || !clientSecret) {
    throw new Error("HEMIS OAuth client ID yoki client code sozlanmagan")
  }

  const oauthBase = oauthBaseForRole(role)
  const tokenUrl = `${oauthBase}/oauth/access-token`
  const baseBody = {
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  }
  const attempts = [
    {
      name: "body-client-secret",
      body: new URLSearchParams({
        ...baseBody,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    },
    {
      name: "basic-auth",
      body: new URLSearchParams({
        ...baseBody,
        client_id: clientId,
      }),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
    },
  ]
  const errors: string[] = []

  for (const attempt of attempts) {
    try {
      const { data } = await axios.post(tokenUrl, attempt.body.toString(), { headers: attempt.headers })
      const payload = asRecord(asRecord(data).data || data)
      const accessToken = textValue(payload.access_token, payload.token)
      if (!accessToken) {
        throw Object.assign(new Error("HEMIS OAuth access token qaytmadi"), { data })
      }

      return {
        oauthBase,
        accessToken,
        refreshToken: textValue(payload.refresh_token),
        expiresIn: numberValue(payload.expires_in),
      }
    } catch (err) {
      const e = err as AxiosError<{ error?: string; error_description?: string; message?: string }>
      const oauthError = textValue(e?.response?.data?.error, e?.response?.data?.message)
      const oauthDescription = textValue(e?.response?.data?.error_description)
      errors.push(`${attempt.name}: ${e?.response?.status ?? "no-status"} ${[oauthError, oauthDescription].filter(Boolean).join(" - ") || extractMessage(err)}`)
    }
  }

  throw Object.assign(
    new Error("HEMIS OAuth client authentication failed. Client ID/client code yoki OAuth redirect URL HEMISdagi klient sozlamasiga mos emas"),
    { details: errors }
  )
}

function oauthFieldsForRole(role: OAuthRole) {
  if (role === "employee" || role === "tutor") return HEMIS_OAUTH_EMPLOYEE_FIELDS
  if (role === "student") return HEMIS_OAUTH_STUDENT_FIELDS
  return Array.from(new Set([...HEMIS_OAUTH_EMPLOYEE_FIELDS, ...HEMIS_OAUTH_STUDENT_FIELDS]))
}

async function hemisOAuthUser(oauthBase: string, accessToken: string, role: OAuthRole) {
  const fields = oauthFieldsForRole(role).join(",")

  const { data } = await axios.get(`${oauthBase}/oauth/api/user`, {
    params: { fields },
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  })
  return asRecord(asRecord(data).data || data)
}

async function createOAuthSession(requestedRole: OAuthRole, code: string, redirectUri: string, expectedLogin?: string) {
  const { oauthBase, accessToken } = await hemisOAuthAccessToken(requestedRole, code, redirectUri)
  const oauthUser = await hemisOAuthUser(oauthBase, accessToken, requestedRole)
  const role = detectOAuthUserRole(oauthUser, requestedRole)
  const oauthProfile = profileFromOAuthUser(oauthUser, role)

  if (role === "student") {
    const studentApiToken = textValue(
      oauthUser.student_api_token,
      oauthProfile.student_api_token,
      asRecord(oauthUser.student).student_api_token
    )
    if (!studentApiToken) {
      throw new Error("HEMIS OAuth student_api_token qaytarmadi")
    }

    let profile = oauthProfile
    try {
      const profileData = await hemisGet(HEMIS, "/v1/account/me", studentApiToken)
      profile = asRecord((profileData as any)?.data ?? profileData)
    } catch (profileErr) {
      console.warn("[HEMIS student oauth] Profil olishda xato:", extractMessage(profileErr))
    }

    const token = signStudentToken(studentApiToken, textValue(oauthUser.login, oauthUser.name) || "hemis-oauth", profile, "oauth")
    return { token, role: "student" as const }
  }

  const enrichedProfile = await enrichEmployeeProfile(oauthProfile)
  // Xodimning raqamli HEMIS ID'si (yoki undefined — JWT'dan olib qoldiramiz)
  const numericEmployeeId = numberValue(
    enrichedProfile.id,
    enrichedProfile.meta_id,
    enrichedProfile.employee_id_number
  ) ?? undefined

  const token = jwt.sign(
    {
      // id va userId top-level da bo'lsa teacherUserId() to'g'ri hisoblaydi
      ...(numericEmployeeId ? { id: numericEmployeeId, userId: numericEmployeeId } : {}),
      hemisToken: accessToken,
      role: "employee",
      username: textValue(enrichedProfile.full_name, enrichedProfile.name, enrichedProfile.login) || "HEMIS xodim",
      fullName: textValue(enrichedProfile.full_name, enrichedProfile.name, enrichedProfile.login),
      isEmployee: true,
      employeeHemisBase: HEMIS_EMPLOYEE,
      employeeAuthMode: "oauth",
      employeeProfile: enrichedProfile,
      teacherGroupIds: resolveEmployeeGroupIds(enrichedProfile),
      employeeType: textValue(
        asRecord(enrichedProfile.employeeType).name,
        asRecord(enrichedProfile.staffPosition).name,
        textValue(enrichedProfile.type),
        "O'qituvchi"
      ),
    },
    JWT_SECRET,
    { expiresIn: "2d" }
  )
  return { token, role: "employee" as const }
}

function profileFromOAuthUser(user: Record<string, unknown>, role: OAuthRole): Record<string, unknown> {
  const firstName  = fixName(textValue(user.first_name,  user.firstname)  ?? "")
  const secondName = fixName(textValue(user.second_name, user.surname)    ?? "")
  const thirdName  = fixName(textValue(user.third_name,  user.patronymic) ?? "")
  const composedName = [secondName, firstName, thirdName].filter(Boolean).join(" ")
  const fullName = fixName(textValue(user.full_name, user.name, composedName, user.login) ?? "")
  const idNumber = textValue(user.employee_id_number, user.student_id_number, user.university_id, user.id)

  return {
    ...user,
    first_name: firstName,
    second_name: secondName,
    third_name: thirdName,
    full_name: fullName,
    short_name: textValue(user.short_name, fullName, user.login),
    image: textValue(user.image, user.picture),
    ...(role === "employee" || role === "tutor"
      ? {
          employee_id_number: idNumber,
          employeeType: asRecord(user.employeeType).name ? user.employeeType : { id: "oauth", name: "O'qituvchi", code: "teacher" },
          staffPosition: asRecord(user.staffPosition).name ? user.staffPosition : { id: "oauth", name: "O'qituvchi" },
          active: true,
        }
      : {
          student_id_number: idNumber,
        }),
  }
}

function detectOAuthUserRole(user: Record<string, unknown>, requestedRole: OAuthRole): "student" | "employee" {
  if (requestedRole === "student") return "student"
  if (requestedRole === "employee" || requestedRole === "tutor") return "employee"

  const type = textValue(user.type, asRecord(user.type).name, asRecord(user.type).code)?.toLowerCase() ?? ""
  if (type.includes("student") || type.includes("talaba")) return "student"
  if (textValue(user.student_api_token, asRecord(user.student).student_api_token)) return "student"
  return "employee"
}

function normalizedLogin(value: unknown) {
  return textValue(value)?.trim().toLowerCase().replace(/^@+/, "")
}

function oauthUserLoginCandidates(user: Record<string, unknown>, profile: Record<string, unknown>) {
  return [
    normalizedLogin(user.login),
    normalizedLogin(profile.login),
    normalizedLogin(user.username),
    normalizedLogin(profile.username),
    normalizedLogin(user.email),
    normalizedLogin(profile.email),
    normalizedLogin(user.employee_id_number),
    normalizedLogin(profile.employee_id_number),
    normalizedLogin(user.university_id),
    normalizedLogin(profile.university_id),
  ].filter(Boolean) as string[]
}

async function enrichEmployeeProfile(profile: Record<string, unknown>) {
  if (!HEMIS_TOKEN) return profile

  const searchTerms = [
    textValue(profile.employee_id_number, profile.university_id, profile.id),
    textValue(profile.login),
    textValue(profile.full_name, profile.name),
    textValue(profile.email),
  ].filter(Boolean) as string[]

  for (const search of searchTerms) {
    try {
      const data = await hemisGet(HEMIS_BASE, "/v1/data/employee-list", HEMIS_TOKEN, {
        type: "all",
        limit: "5",
        search,
      })
      const items = unwrapHemisData(data)
      if (Array.isArray(items) && items.length) {
        const exact = items.find((item) => {
          const record = asRecord(item)
          const employeeId = textValue(record.employee_id_number, record.university_id, record.id)
          const login = textValue(record.login)
          const name = textValue(record.full_name, record.name)
          return employeeId === search || login === search || name === search
        })
        return { ...profile, ...asRecord(exact || items[0]) }
      }
    } catch (err) {
      console.warn("[HEMIS employee oauth] employee-list enrich xato:", extractMessage(err))
    }
  }

  return profile
}

const employeeResourcePaths: Record<string, string[]> = {
  dashboard: [
    "/v1/data/attendance-control-list",
    "/v1/data/schedule-list",
    "/v1/data/employee-subject-list",
    "/v1/data/exam-list",
  ],
  "personal-plan": [
    "/v1/data/teacher-workload",
  ],
  "document-signing": [],
  "subject-topics": [
    "/v1/data/curriculum-subject-list",
  ],
  "subject-resources": [
    "/v1/data/subject-file-resource-list",
  ],
  "subject-tasks": [
    "/v1/data/curriculum-subject-teacher-list",
  ],
  "course-tasks": [
    "/v1/data/curriculum-subject-teacher-list",
  ],
  "calendar-plan": [
    "/v1/data/curriculum-subject-teacher-list",
  ],
  "subject-info": [
    "/v1/data/employee-subject-list",
    "/v1/data/curriculum-subject-list",
    "/v1/data/all-subject-list",
  ],
  exams: [
    "/v1/data/exam-list",
  ],
  "single-students": [
    "/v1/data/student-list",
  ],
  "single-schedule": [
    "/v1/data/schedule-list",
  ],
  "single-attendance": [
    "/v1/data/attendance-list",
  ],
  "lesson-schedule": [
    "/v1/data/schedule-list",
  ],
  "lesson-list": [
    "/v1/data/schedule-list",
  ],
  "attendance-journal": [
    "/v1/data/attendance-control-list",
  ],
  "grade-journal": [
    "/v1/data/student-grade-list",
  ],
  retraining: [
    "/v1/data/student-performance-list",
    "/v1/data/academic-record-list",
  ],
  "personal-records": [
    "/v1/data/academic-record-list",
    "/v1/data/student-grade-list",
  ],
  "grading-surveys": [
    "/v1/data/poll-list",
  ],
  lessons: [
    "/v1/data/schedule-list",
    "/v1/data/attendance-control-list",
  ],
  controls: [
    "/v1/data/subject-exam-list",
  ],
  "midterm-controls": [
    "/v1/data/subject-exam-list",
  ],
  "final-controls": [
    "/v1/data/subject-exam-list",
  ],
  "other-controls": [
    "/v1/data/subject-exam-list",
  ],
  "scientific-activity": [
    "/v1/data/scientific-activity",
    "/v1/data/scientific",
    "/v1/data/methodical",
  ],
  statistics: [
    "/v1/data/employee-stats",
    "/v1/data/attendance-stat",
  ],
  reports: [
    "/v1/data/system-log-list",
  ],
  messages: [
    "/v1/data/system-log-list",
  ],
  settings: [
    "/v1/data/employee-list",
  ],
}

function collectStringParams(query: AuthRequest["query"]) {
  const params: Record<string, string> = {}
  Object.entries(query).forEach(([key, value]) => {
    if (typeof value === "string") params[key] = value
    else if (Array.isArray(value) && typeof value[0] === "string") params[key] = value[0]
  })
  return params
}

function unwrapHemisData(value: unknown) {
  const record = asRecord(value)
  const raw = "data" in record ? record.data : "result" in record ? record.result : value
  if (Array.isArray(raw) && raw.length === 1) {
    const first = asRecord(raw[0])
    if (Array.isArray(first.items)) return first.items
  }
  const rawRecord = asRecord(raw)
  return "items" in rawRecord ? rawRecord.items : raw
}

function unwrapHemisPagination(value: unknown) {
  const record = asRecord(value)
  const raw = "data" in record ? record.data : "result" in record ? record.result : value
  const candidates = [
    asRecord(raw).pagination,
    Array.isArray(raw) ? asRecord(raw[0]).pagination : undefined,
    record.pagination,
  ]

  for (const candidate of candidates) {
    if (!candidate) continue
    if (Array.isArray(candidate)) {
      const first = asRecord(candidate[0])
      if (Object.keys(first).length) return first
      continue
    }
    const pagination = asRecord(candidate)
    if (Object.keys(pagination).length) return pagination
  }

  return {}
}

const employeeScopedDataPaths = new Set([
  "/v1/data/academic-record-list",
  "/v1/data/attendance-control-list",
  "/v1/data/attendance-list",
  "/v1/data/employee-subject-list",
  "/v1/data/exam-list",
  "/v1/data/poll-list",
  "/v1/data/schedule-list",
  "/v1/data/student-grade-list",
  "/v1/data/subject-task-student-list",
  "/v1/data/subject-exam-list",
  "/v1/data/teacher-workload",
])

function employeeProfileFromUser(user?: AuthRequest["user"]) {
  return asRecord(user?.employeeProfile)
}

function employeeIdFromUser(user?: AuthRequest["user"]) {
  const profile = employeeProfileFromUser(user)
  const nestedEmployee = asRecord(profile.employee)
  return textValue(
    user?.id,
    user?.userId,
    nestedEmployee.id,
    profile.id,
    profile.meta_id,
    profile.employee_id,
    profile.employee_id_number
  )
}

function employeeSearchFromUser(user?: AuthRequest["user"]) {
  const profile = employeeProfileFromUser(user)
  return textValue(
    profile.employee_id_number,
    profile.university_id,
    profile.login,
    profile.full_name,
    profile.name,
    user?.fullName,
    user?.username
  )
}

function employeeDataParams(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  const next: Record<string, string> = { limit: "20", ...params }

  if (path === "/v1/data/employee-list") {
    next.type ||= "all"
    next.search ||= employeeSearchFromUser(user) || ""
    if (!next.search) delete next.search
    return next
  }

  const employeeId = employeeIdFromUser(user)
  if (path.startsWith("/v1/data/") && employeeScopedDataPaths.has(path) && employeeId && !next._employee) {
    next._employee = employeeId
  }

  return next
}

async function employeeDataItems(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  const data = await hemisGet(HEMIS_BASE, path, HEMIS_TOKEN, employeeDataParams(path, params, user))
  return unwrapHemisData(data)
}

async function employeeDataPage(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  const data = await hemisGet(HEMIS_BASE, path, HEMIS_TOKEN, employeeDataParams(path, params, user))
  return {
    items: unwrapHemisData(data),
    pagination: unwrapHemisPagination(data),
  }
}

async function employeeDataAllItems(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  const pageSize = params.limit || "200"
  const first = await employeeDataPage(path, { ...params, page: params.page || "1", limit: pageSize }, user)
  const firstItems = Array.isArray(first.items) ? first.items : normalizeDataItems(first.items)
  const pageCount = numberValue(first.pagination.pageCount) ?? 1

  if (params.page || pageCount <= 1) return firstItems

  const pages = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) =>
      employeeDataPage(path, { ...params, page: String(index + 2), limit: pageSize }, user)
        .then((page) => Array.isArray(page.items) ? page.items : normalizeDataItems(page.items))
    )
  )

  return firstItems.concat(...pages)
}

async function employeeDataFirstItems(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  const page = await employeeDataPage(path, { ...params, page: params.page || "1", limit: params.limit || "20" }, user)
  return Array.isArray(page.items) ? page.items : normalizeDataItems(page.items)
}

async function employeeDataTotal(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  const data = await hemisGet(HEMIS_BASE, path, HEMIS_TOKEN, employeeDataParams(path, { ...params, page: "1", limit: "1" }, user))
  const totalCount = numberValue(unwrapHemisPagination(data).totalCount)
  return totalCount ?? itemCount(unwrapHemisData(data))
}

function normalizeDataItems(value: unknown) {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  if (Array.isArray(record.items)) return record.items
  if (Array.isArray(record.rows)) return record.rows
  if (Array.isArray(record.data)) return record.data
  if (Object.keys(record).length) return [record]
  return []
}

function formatUnixDateTime(value: unknown) {
  const timestamp = numberValue(value)
  if (!timestamp) return undefined
  return new Intl.DateTimeFormat("uz-UZ", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000))
}

function fileCount(value: unknown): number {
  if (!Array.isArray(value)) return 0
  return value.reduce((total, item) => {
    const record = asRecord(item)
    if (Array.isArray(record.files)) return total + record.files.length
    return total + 1
  }, 0)
}

function employeeSubjectIdSet(items: unknown[]) {
  return new Set(
    items
      .map((item) => textValue(asRecord(asRecord(item).subject).id))
      .filter(Boolean) as string[]
  )
}

function resourceMatchesEmployeeSubjects(item: unknown, subjectIds: Set<string>) {
  if (!subjectIds.size) return true
  const subject = asRecord(asRecord(item).subject)
  const subjectId = textValue(subject.id)
  return Boolean(subjectId && subjectIds.has(subjectId))
}

function normalizeSubjectResource(item: unknown) {
  const record = asRecord(item)
  const items = record.subjectFileResourceItems
  return {
    ...record,
    file_count: fileCount(items),
    created_label: formatUnixDateTime(record.updated_at ?? record.created_at),
  }
}

function employeeDepartmentId(user?: AuthRequest["user"]) {
  const profile = employeeProfileFromUser(user)
  return textValue(asRecord(profile.department).id, profile.department_id, profile._department)
}

function trainingLoadLabel(value: unknown) {
  if (!Array.isArray(value)) return "-"
  const seen = new Map<string, string>()
  value.forEach((item) => {
    const record = asRecord(item)
    const trainingType = asRecord(record.trainingType)
    const name = textValue(trainingType.name)
    if (!name) return
    const load = textValue(record.topic_load, record.academic_load)
    seen.set(name, load ? `${name} [${load} / ${load}]` : name)
  })
  return seen.size ? Array.from(seen.values()).join(", ") : "-"
}

async function curriculumMap(params: Record<string, string>) {
  const curriculumParams: Record<string, string> = { limit: "200" }
  const items = await employeeDataAllItems("/v1/data/curriculum-list", curriculumParams, undefined)
  return new Map(items.map((item) => [textValue(asRecord(item).id), asRecord(item)] as const).filter(([id]) => Boolean(id)))
}

async function departmentMap() {
  const items = await employeeDataAllItems("/v1/data/department-list", { limit: "200" }, undefined)
  return new Map(items.map((item) => [textValue(asRecord(item).id), asRecord(item)] as const).filter(([id]) => Boolean(id)))
}

async function groupMapForCurricula(curriculumIds: Iterable<string>) {
  const ids = Array.from(new Set(Array.from(curriculumIds).filter(Boolean)))
  const map = new Map<string, Record<string, unknown>>()
  await Promise.all(
    ids.map(async (curriculumId) => {
      const items = await employeeDataAllItems("/v1/data/group-list", { _curriculum: curriculumId, limit: "200" }, undefined)
      items.forEach((item) => {
        const record = asRecord(item)
        const id = textValue(record.id)
        if (id) map.set(id, record)
      })
    })
  )
  return map
}

function curriculumOptions(curricula: Map<string | undefined, Record<string, unknown>>) {
  return Array.from(curricula.entries())
    .map(([id, item]) => ({
      value: id,
      label: textValue(item.name, item.code) || id,
    }))
    .filter((item): item is { value: string; label: string } => Boolean(item.value && item.label))
}

async function subjectTopicItems(params: Record<string, string>, user?: AuthRequest["user"]) {
  const targetLimit = numberValue(params.limit) ?? 200
  const curricula = await curriculumMap(params).catch(() => new Map<string | undefined, Record<string, unknown>>())
  const departments = await departmentMap().catch(() => new Map<string | undefined, Record<string, unknown>>())
  const teacherItems = await employeeDataFirstItems(
    "/v1/data/curriculum-subject-teacher-list",
    { ...params, limit: String(targetLimit) },
    user
  )
  const groupedTeacherItems = groupedSubjectTeacherItems(teacherItems, curricula, departments, params)
  if (groupedTeacherItems.length) return groupedTeacherItems.slice(0, targetLimit)

  const requestParams: Record<string, string> = { ...params, limit: String(targetLimit) }
  delete requestParams._employee
  delete requestParams._education_year
  const departmentId = employeeDepartmentId(user)
  if (departmentId && !requestParams._department) requestParams._department = departmentId

  let items: unknown[] = []

  if (!params._curriculum && params._education_year && curricula.size) {
    for (const curriculumId of Array.from(curricula.keys()).filter(Boolean)) {
      const pageItems = await employeeDataFirstItems(
        "/v1/data/curriculum-subject-list",
        { ...requestParams, _curriculum: String(curriculumId), limit: String(Math.min(targetLimit, 200)) },
        undefined
      )
      items.push(...pageItems)
      if (items.length >= targetLimit) break
    }
  } else {
    items = await employeeDataFirstItems("/v1/data/curriculum-subject-list", requestParams, undefined)
  }

  return items
    .map((item) => {
      const record = asRecord(item)
      const curriculum = curricula.get(textValue(record._curriculum))
      return {
        ...record,
        curriculum,
        educationYear: asRecord(curriculum).educationYear,
        educationType: asRecord(curriculum).educationType,
        educationForm: asRecord(curriculum).educationForm,
        trainings_label: trainingLoadLabel(record.subjectDetails),
      }
    })
    .filter((item) => {
      if (!params._education_year) return true
      const year = textValue(asRecord(item.educationYear).code)
      return !curricula.size || year === params._education_year
    })
    .slice(0, targetLimit)
}

function semesterRecord(value: unknown) {
  const code = textValue(value)
  const number = numberValue(code)
  const name = number && number >= 11 ? `${number - 10}-semestr` : code
  return { code, name }
}

const TRAINING_TYPE_NAMES: Record<string, string> = {
  "11": "Ma'ruza",
  "12": "Amaliy mashg'ulot",
  "13": "Laboratoriya mashg'uloti",
  "14": "Seminar mashg'uloti",
  "15": "Kurs ishi (loyihasi)",
  "16": "Mustaqil ta'lim",
}

function trainingTypeRecord(code: unknown, fallbackName?: unknown) {
  const codeText = textValue(code)
  const name = textValue(fallbackName) || (codeText ? TRAINING_TYPE_NAMES[codeText] : undefined) || codeText
  return { code: codeText, name }
}

function academicYearRecord(value: unknown) {
  const year = numberValue(value)
  if (!year) return undefined
  return { code: String(year), name: `${year}-${year + 1}` }
}

function groupedSubjectTeacherItems(
  items: unknown[],
  curricula: Map<string | undefined, Record<string, unknown>>,
  departments: Map<string | undefined, Record<string, unknown>>,
  params: Record<string, string>
) {
  const map = new Map<string, Record<string, unknown> & { subjectDetails: unknown[] }>()
  const educationYear = academicYearRecord(params._education_year)

  items.forEach((item) => {
    const record = asRecord(item)
    const subject = asRecord(record.subject)
    const curriculumId = textValue(record._curriculum)
    const semester = textValue(record._semester)
    const key = [curriculumId, textValue(subject.id, subject.name), semester].filter(Boolean).join("|")
    if (!key) return

    const current = map.get(key)
    const detail = asRecord(record.curriculumSubjectDetail)
    if (current) {
      if (Object.keys(detail).length) current.subjectDetails.push(detail)
      return
    }

    const curriculum = curricula.get(curriculumId)
    const department = departments.get(textValue(record._department))
    map.set(key, {
      ...record,
      curriculum,
      semester: semesterRecord(semester),
      educationYear,
      educationType: asRecord(curriculum).educationType,
      educationForm: asRecord(curriculum).educationForm,
      department: department ?? asRecord(record.department),
      subjectDetails: Object.keys(detail).length ? [detail] : [],
    })
  })

  return Array.from(map.values()).map((item) => ({
    ...item,
    trainings_label: trainingLoadLabel(item.subjectDetails),
  }))
}

async function subjectTopicOptions(params: Record<string, string>, user?: AuthRequest["user"]) {
  const curricula = await curriculumMap(params).catch(() => new Map<string | undefined, Record<string, unknown>>())
  const teacherItems = await employeeDataFirstItems("/v1/data/curriculum-subject-teacher-list", { ...params, limit: "200" }, user)
  const teacherCurricula = new Map(
    teacherItems
      .map((item) => {
        const curriculumId = textValue(asRecord(item)._curriculum)
        const curriculum = curricula.get(curriculumId)
        return curriculumId && curriculum ? [curriculumId, curriculum] as const : undefined
      })
      .filter((item): item is readonly [string, Record<string, unknown>] => Boolean(item))
  )
  return {
    _curriculum: curriculumOptions(teacherCurricula.size ? teacherCurricula : curricula),
  }
}

async function employeeSubjectItems(params: Record<string, string>, user?: AuthRequest["user"]) {
  return (await employeeDataAllItems("/v1/data/employee-subject-list", params, user))
    .filter((item) => itemMatchesEmployeeFilters(item, params))
}

async function subjectResourcesForEmployee(params: Record<string, string>, user?: AuthRequest["user"]) {
  const subjects = await employeeSubjectItems(params, user)
  const subjectIds = employeeSubjectIdSet(subjects)
  const subjectParam = params._subject
  const fetchSubjectIds = subjectParam ? [subjectParam] : Array.from(subjectIds)
  const resourceParams = { ...params }
  delete resourceParams._employee
  delete resourceParams._education_year
  const combinedLimit = numberValue(params.limit) ?? 200

  const results: unknown[] = []
  for (const subjectId of fetchSubjectIds.slice(0, 20)) {
    const items = await employeeDataFirstItems(
      "/v1/data/subject-file-resource-list",
      { ...resourceParams, _subject: subjectId, limit: String(Math.min(combinedLimit, 50)) },
      undefined
    )
    results.push(...items.filter((item) => resourceMatchesEmployeeSubjects(item, subjectIds)))
    if (results.length >= combinedLimit) break
  }

  return results
    .sort((left, right) => (numberValue(asRecord(right).updated_at) ?? 0) - (numberValue(asRecord(left).updated_at) ?? 0))
    .slice(0, combinedLimit)
    .map(normalizeSubjectResource)
}

/* ── HEMIS attendance-list elementini jurnal qatori uchun normallashtirish ── */
function normalizeAttendanceRecordItem(item: unknown) {
  const record = asRecord(item)
  const student = asRecord(record.student)
  const lessonPair = asRecord(record.lessonPair)
  const lessonDateValue = numberValue(record.lesson_date, record.lessonDate)
  const studentHemisId = numberValue(student.id)

  return {
    studentUserId: studentHemisId !== null ? studentUserId({ id: studentHemisId }) : null,
    studentName: textValue(student.name) ?? "-",
    lessonDate: lessonDateValue !== null ? toMysqlDateOnly(new Date(lessonDateValue * 1000)) : null,
    lessonPairName: textValue(lessonPair.name) ?? null,
    startTime: textValue(lessonPair.start_time) ?? null,
    endTime: textValue(lessonPair.end_time) ?? null,
    absentOn: numberValue(record.absent_on) ?? 0,
    absentOff: numberValue(record.absent_off) ?? 0,
  }
}

/* ── HEMIS student-grade-list elementini jurnal qatori uchun normallashtirish ── */
function normalizeGradeRecordItem(item: unknown) {
  const record = asRecord(item)
  const student = asRecord(record.student)
  const lessonPair = asRecord(record.lessonPair)
  const lessonDateValue = numberValue(record.lesson_date, record.lessonDate)
  const studentHemisId = numberValue(student.id, record._student)

  return {
    studentUserId: studentHemisId !== null ? studentUserId({ id: studentHemisId }) : null,
    studentName: textValue(student.name) ?? "-",
    lessonDate: lessonDateValue !== null ? toMysqlDateOnly(new Date(lessonDateValue * 1000)) : null,
    lessonPairName: textValue(lessonPair.name) ?? null,
    startTime: textValue(lessonPair.start_time) ?? null,
    endTime: textValue(lessonPair.end_time) ?? null,
    grade: numberValue(record.grade),
  }
}

function attendanceJournalKey(item: unknown) {
  const record = asRecord(item)
  return [
    textValue(asRecord(record.group).id, asRecord(record.group).name),
    textValue(asRecord(record.subject).id, asRecord(record.subject).name),
    textValue(asRecord(record.trainingType).code, asRecord(record.trainingType).id, asRecord(record.trainingType).name),
    textValue(asRecord(record.educationYear).code, asRecord(record.educationYear).name),
    textValue(asRecord(record.semester).code, asRecord(record.semester).name),
  ].filter(Boolean).join("|")
}

function attendanceJournalItems(items: unknown[]) {
  const map = new Map<string, unknown>()
  items.forEach((item) => {
    const key = attendanceJournalKey(item)
    if (key && !map.has(key)) map.set(key, item)
  })
  return Array.from(map.values())
}

function itemMatchesEmployeeFilters(item: unknown, params: Record<string, string>) {
  const record = asRecord(item)
  const year = params._education_year
  // Ba'zi resurslar (masalan SubjectTaskStudent) educationYear/semester maydonlarini
  // o'zida saqlamaydi - bunday holda HEMIS server tomonida _education_year/_semester
  // bo'yicha filtrlash allaqachon bajarilgan deb hisoblanadi va element rad etilmaydi.
  if (year && ("educationYear" in record || "_education_year" in record)) {
    const educationYear = asRecord(record.educationYear)
    const values = [
      textValue(educationYear.code),
      textValue(educationYear.name),
      textValue(record._education_year),
    ].filter(Boolean)
    if (!values.some((value) => value === year || value?.startsWith(`${year}-`))) return false
  }

  const semester = params._semester
  if (semester && ("semester" in record || "_semester" in record)) {
    const semesterRecord = asRecord(record.semester)
    const semesterNumber = Number(semester)
    const plainSemester = Number.isFinite(semesterNumber) && semesterNumber >= 11 && semesterNumber <= 20
      ? String(semesterNumber - 10)
      : semester
    const values = [
      textValue(semesterRecord.code),
      textValue(semesterRecord.id),
      textValue(semesterRecord.name),
      textValue(record._semester),
    ].filter(Boolean)
    if (!values.some((value) => value === semester || value === plainSemester || value?.startsWith(`${plainSemester}-`))) {
      return false
    }
  }

  return true
}

async function attendanceJournalCount(params: Record<string, string>, user?: AuthRequest["user"]) {
  const items = (await employeeDataAllItems("/v1/data/attendance-control-list", params, user))
    .filter((item) => itemMatchesEmployeeFilters(item, params))
  return attendanceJournalItems(items).length || items.length
}

function controlKind(item: unknown): "midterm" | "final" | "other" {
  const record = asRecord(item)
  const examType = asRecord(record.examType)
  const finalExamType = asRecord(record.finalExamType)
  const text = [
    textValue(examType.name, examType.code),
    textValue(finalExamType.name, finalExamType.code),
    textValue(record.name, record.title),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()

  if (text.includes("oraliq") || text.includes("joriy") || text.includes("current") || text.includes("midterm")) {
    return "midterm"
  }
  if (text.includes("yakuniy") || text.includes("final")) return "final"
  return "other"
}

async function controlItems(params: Record<string, string>, user?: AuthRequest["user"]) {
  return (await employeeDataAllItems("/v1/data/subject-exam-list", params, user))
    .filter((item) => itemMatchesEmployeeFilters(item, params))
}

async function subjectTaskCountForRow(taskParams: Record<string, string>, user?: AuthRequest["user"]) {
  const items = await employeeDataAllItems("/v1/data/subject-task-student-list", taskParams, user)
  const ids = new Set<string>()
  let maxBall = 0
  items.forEach((item) => {
    const record = asRecord(item)
    const activity = asRecord(record.studentTaskActivity)
    // Har bir topshiriq talaba soniga ko'paytirilib qaytadi (bitta topshiriq - har bir talaba uchun alohida qator),
    // shuning uchun aniq topshiriq soni uchun studentTaskActivity._task bo'yicha unikal qiymatlar sanaladi.
    const taskId = textValue(activity._task) ?? textValue(record.id)
    if (taskId) ids.add(taskId)
    const ball = numberValue(record.max_ball) ?? 0
    if (ball > maxBall) maxBall = ball
  })
  return { task_count: ids.size, max_ball: maxBall }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  async function worker() {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await fn(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

async function subjectTaskListItems(params: Record<string, string>, user?: AuthRequest["user"]) {
  const employeeId = employeeIdFromUser(user)
  const teacherParams: Record<string, string> = { limit: "200" }
  if (employeeId) teacherParams._employee = employeeId
  if (params._education_year) teacherParams._education_year = params._education_year
  if (params._semester) teacherParams._semester = params._semester
  if (params._group) teacherParams._group = params._group
  if (params._subject) teacherParams._subject = params._subject
  if (params._curriculum) teacherParams._curriculum = params._curriculum
  if (params._training_type) teacherParams._training_type = params._training_type

  const [teacherItems, curricula] = await Promise.all([
    employeeDataAllItems("/v1/data/curriculum-subject-teacher-list", teacherParams, undefined),
    curriculumMap(params).catch(() => new Map<string | undefined, Record<string, unknown>>()),
  ])

  const groups = await groupMapForCurricula(teacherItems.map((item) => textValue(asRecord(item)._curriculum) ?? "")).catch(
    () => new Map<string, Record<string, unknown>>()
  )

  // Bir xil fan + o'quv reja + mashg'ulot turi + semestr uchun bir nechta guruh bo'lishi mumkin -
  // HEMIS bularni bitta qatorga birlashtirib, guruhlarni rasmlardagidek qatorda ko'rsatadi.
  const grouped = new Map<string, {
    subject: Record<string, unknown>
    curriculum: Record<string, unknown> | undefined
    curriculumId: string | undefined
    trainingType: Record<string, unknown>
    semester: { code?: string; name?: string }
    educationYear: unknown
    groupIds: Set<string>
  }>()

  teacherItems.forEach((item) => {
    const record = asRecord(item)
    const subject = asRecord(record.subject)
    const curriculumId = textValue(record._curriculum)
    const curriculum = curricula.get(curriculumId)
    const detail = asRecord(record.curriculumSubjectDetail)
    const detailTrainingType = asRecord(detail.trainingType)
    const trainingType = trainingTypeRecord(record._training_type ?? detailTrainingType.code, detailTrainingType.name)
    const educationYear = asRecord(curriculum).educationYear
    const semester = semesterRecord(record._semester)
    const groupId = textValue(record._group)

    const key = [textValue(subject.id), curriculumId, textValue(trainingType.code), textValue(record._semester)]
      .filter(Boolean)
      .join("|")
    if (!key) return

    const current = grouped.get(key)
    if (current) {
      if (groupId) current.groupIds.add(groupId)
      return
    }

    grouped.set(key, {
      subject,
      curriculum,
      curriculumId,
      trainingType,
      semester,
      educationYear,
      groupIds: new Set(groupId ? [groupId] : []),
    })
  })

  const rows = Array.from(grouped.values())

  const counts = await mapWithConcurrency(rows, 4, ({ subject, curriculumId, trainingType, semester }) => {
    const taskParams: Record<string, string> = { limit: "200" }
    if (employeeId) taskParams._employee = employeeId
    if (textValue(subject.id)) taskParams._subject = textValue(subject.id) as string
    if (curriculumId) taskParams._curriculum = curriculumId
    if (textValue(trainingType.code)) taskParams._training_type = textValue(trainingType.code) as string
    if (semester.code) taskParams._semester = semester.code
    if (params._education_year) taskParams._education_year = params._education_year
    return subjectTaskCountForRow(taskParams, user).catch(() => ({ task_count: 0, max_ball: 0 }))
  })

  return rows.map(({ subject, curriculum, curriculumId, trainingType, semester, educationYear, groupIds }, index) => {
    const sortedGroupIds = Array.from(groupIds).sort((left, right) => {
      const leftName = textValue(groups.get(left)?.name) ?? left
      const rightName = textValue(groups.get(right)?.name) ?? right
      return leftName.localeCompare(rightName, undefined, { numeric: true })
    })
    const groupRecords = sortedGroupIds.map((id) => groups.get(id)).filter((value): value is Record<string, unknown> => Boolean(value))
    const rowCounts = counts[index]

    return {
      subject,
      curriculum,
      group: groupRecords[0] ?? {},
      groups: groupRecords,
      trainingType,
      semester,
      educationYear,
      educationLang: asRecord(groupRecords[0]?.educationLang),
      task_count: rowCounts.task_count,
      max_ball: rowCounts.max_ball,
      _subject: textValue(subject.id),
      _group: sortedGroupIds[0],
      _curriculum: curriculumId,
      _training_type: textValue(trainingType.code),
      _semester: textValue(semester.code),
      _education_year: textValue(asRecord(educationYear).code),
    }
  })
}

// "Fan topshiriqlari" - Ma'ruza/Amaliy/Laboratoriya/Seminar (11-14) mashg'ulotlari.
// "Kurs topshiriqlari" - shulardan tashqari turlar (Kurs ishi, Malaka amaliyoti va h.k.).
const REGULAR_TRAINING_TYPE_CODES = new Set(["11", "12", "13", "14"])

async function courseTaskListItems(params: Record<string, string>, user?: AuthRequest["user"]) {
  const employeeId = employeeIdFromUser(user)
  const teacherParams: Record<string, string> = { limit: "200" }
  if (employeeId) teacherParams._employee = employeeId
  if (params._education_year) teacherParams._education_year = params._education_year
  if (params._semester) teacherParams._semester = params._semester
  if (params._group) teacherParams._group = params._group
  if (params._subject) teacherParams._subject = params._subject
  if (params._curriculum) teacherParams._curriculum = params._curriculum

  const [teacherItems, curricula] = await Promise.all([
    employeeDataAllItems("/v1/data/curriculum-subject-teacher-list", teacherParams, undefined),
    curriculumMap(params).catch(() => new Map<string | undefined, Record<string, unknown>>()),
  ])

  const groups = await groupMapForCurricula(teacherItems.map((item) => textValue(asRecord(item)._curriculum) ?? "")).catch(
    () => new Map<string, Record<string, unknown>>()
  )

  const grouped = new Map<string, {
    subject: Record<string, unknown>
    curriculum: Record<string, unknown> | undefined
    curriculumId: string | undefined
    trainingType: Record<string, unknown>
    semester: { code?: string; name?: string }
    educationYear: unknown
    groupIds: Set<string>
  }>()

  teacherItems.forEach((item) => {
    const record = asRecord(item)
    const subject = asRecord(record.subject)
    const curriculumId = textValue(record._curriculum)
    const curriculum = curricula.get(curriculumId)
    const detail = asRecord(record.curriculumSubjectDetail)
    const detailTrainingType = asRecord(detail.trainingType)
    const trainingType = trainingTypeRecord(record._training_type ?? detailTrainingType.code, detailTrainingType.name)
    if (textValue(trainingType.code) && REGULAR_TRAINING_TYPE_CODES.has(textValue(trainingType.code) as string)) return

    const educationYear = asRecord(curriculum).educationYear
    const semester = semesterRecord(record._semester)
    const groupId = textValue(record._group)

    const key = [textValue(subject.id), curriculumId, textValue(trainingType.code), textValue(record._semester)]
      .filter(Boolean)
      .join("|")
    if (!key) return

    const current = grouped.get(key)
    if (current) {
      if (groupId) current.groupIds.add(groupId)
      return
    }

    grouped.set(key, {
      subject,
      curriculum,
      curriculumId,
      trainingType,
      semester,
      educationYear,
      groupIds: new Set(groupId ? [groupId] : []),
    })
  })

  const rows = Array.from(grouped.values())

  const counts = await mapWithConcurrency(rows, 4, ({ subject, curriculumId, trainingType, semester }) => {
    const taskParams: Record<string, string> = { limit: "200" }
    if (employeeId) taskParams._employee = employeeId
    if (textValue(subject.id)) taskParams._subject = textValue(subject.id) as string
    if (curriculumId) taskParams._curriculum = curriculumId
    if (textValue(trainingType.code)) taskParams._training_type = textValue(trainingType.code) as string
    if (semester.code) taskParams._semester = semester.code
    if (params._education_year) taskParams._education_year = params._education_year
    return subjectTaskCountForRow(taskParams, user).catch(() => ({ task_count: 0, max_ball: 0 }))
  })

  return rows.map(({ subject, curriculum, curriculumId, trainingType, semester, educationYear, groupIds }, index) => {
    const sortedGroupIds = Array.from(groupIds).sort((left, right) => {
      const leftName = textValue(groups.get(left)?.name) ?? left
      const rightName = textValue(groups.get(right)?.name) ?? right
      return leftName.localeCompare(rightName, undefined, { numeric: true })
    })
    const groupRecords = sortedGroupIds.map((id) => groups.get(id)).filter((value): value is Record<string, unknown> => Boolean(value))
    const rowCounts = counts[index]

    return {
      subject,
      curriculum,
      group: groupRecords[0] ?? {},
      groups: groupRecords,
      trainingType,
      controlType: { code: "umumiy", name: "Umumiy" },
      semester,
      educationYear,
      educationLang: asRecord(groupRecords[0]?.educationLang),
      task_count: rowCounts.task_count,
      max_ball: rowCounts.max_ball,
      _subject: textValue(subject.id),
      _group: sortedGroupIds[0],
      _curriculum: curriculumId,
      _training_type: textValue(trainingType.code),
      _semester: textValue(semester.code),
      _education_year: textValue(asRecord(educationYear).code),
    }
  })
}

type CalendarPlanFileRowKey = {
  subjectId: string
  curriculumId?: string
  semesterCode?: string
  trainingTypeCode?: string
}

function calendarPlanFileMapKey(row: CalendarPlanFileRowKey): string {
  return [row.subjectId, row.curriculumId, row.semesterCode, row.trainingTypeCode].filter(Boolean).join("|")
}

async function calendarPlanFileMap(rows: CalendarPlanFileRowKey[], user?: AuthRequest["user"]) {
  const map = new Map<string, Array<{ name: string; file: string }>>()
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.subjectId) continue
    const key = calendarPlanFileMapKey(row)
    if (seen.has(key)) continue
    seen.add(key)
    if (seen.size > 30) break
    try {
      const params: Record<string, string> = { _subject: row.subjectId, limit: "1" }
      if (row.curriculumId) params._curriculum = row.curriculumId
      if (row.semesterCode) params._semester = row.semesterCode
      if (row.trainingTypeCode) params._training_type = row.trainingTypeCode
      const items = await employeeDataFirstItems("/v1/data/subject-file-resource-list", params, user)
      const files: Array<{ name: string; file: string }> = []
      const seenNames = new Set<string>()
      const record = asRecord(items[0])
      const resourceItems = Array.isArray(record.subjectFileResourceItems) ? record.subjectFileResourceItems : []
      for (const resourceItem of resourceItems) {
        const resourceFiles = asRecord(resourceItem).files
        if (!Array.isArray(resourceFiles)) continue
        for (const file of resourceFiles) {
          const fileRecord = asRecord(file)
          const fileUrl = textValue(fileRecord.url)
          const fileName = textValue(fileRecord.name) ?? "Fayl"
          if (!fileUrl || seenNames.has(fileName)) continue
          seenNames.add(fileName)
          files.push({ name: fileName, file: fileUrl })
        }
      }
      if (files.length) map.set(key, files)
    } catch {
      // resurs topilmasa, fayl ustuni "-" ko'rsatiladi
    }
  }
  return map
}

// "Kalendar reja" - har bir fan/guruh/mashg'ulot turi/semestr uchun alohida qator
// (HEMIS'dagi kabi - bitta fan bir nechta guruh va mashg'ulot turi bo'yicha qaytariladi).
async function calendarPlanListItems(params: Record<string, string>, user?: AuthRequest["user"]) {
  const employeeId = employeeIdFromUser(user)
  const teacherParams: Record<string, string> = { limit: "200" }
  if (employeeId) teacherParams._employee = employeeId
  if (params._education_year) teacherParams._education_year = params._education_year
  if (params._semester) teacherParams._semester = params._semester
  if (params._group) teacherParams._group = params._group
  if (params._subject) teacherParams._subject = params._subject
  if (params._curriculum) teacherParams._curriculum = params._curriculum
  if (params._training_type) teacherParams._training_type = params._training_type

  const [teacherItems, curricula] = await Promise.all([
    employeeDataAllItems("/v1/data/curriculum-subject-teacher-list", teacherParams, undefined),
    curriculumMap(params).catch(() => new Map<string | undefined, Record<string, unknown>>()),
  ])

  const groups = await groupMapForCurricula(teacherItems.map((item) => textValue(asRecord(item)._curriculum) ?? "")).catch(
    () => new Map<string, Record<string, unknown>>()
  )

  const seen = new Set<string>()
  const rows: Array<{
    subject: Record<string, unknown>
    curriculum: Record<string, unknown> | undefined
    curriculumId: string | undefined
    group: Record<string, unknown>
    trainingType: Record<string, unknown>
    semester: { code?: string; name?: string }
    educationYear: unknown
  }> = []

  teacherItems.forEach((item) => {
    const record = asRecord(item)
    const subject = asRecord(record.subject)
    const curriculumId = textValue(record._curriculum)
    const curriculum = curricula.get(curriculumId)
    const detail = asRecord(record.curriculumSubjectDetail)
    const detailTrainingType = asRecord(detail.trainingType)
    const trainingType = trainingTypeRecord(record._training_type ?? detailTrainingType.code, detailTrainingType.name)
    const educationYear = asRecord(curriculum).educationYear
    const semester = semesterRecord(record._semester)
    const groupId = textValue(record._group)
    const group = (groupId && groups.get(groupId)) || {}

    const key = [textValue(subject.id), curriculumId, textValue(trainingType.code), textValue(semester.code), groupId]
      .filter(Boolean)
      .join("|")
    if (!key || seen.has(key)) return
    seen.add(key)

    rows.push({ subject, curriculum, curriculumId, group, trainingType, semester, educationYear })
  })

  const fileMap = await calendarPlanFileMap(
    rows.map((row) => ({
      subjectId: textValue(row.subject.id) ?? "",
      curriculumId: row.curriculumId,
      semesterCode: textValue(row.semester.code),
      trainingTypeCode: textValue(row.trainingType.code),
    })),
    user
  ).catch(() => new Map<string, Array<{ name: string; file: string }>>())

  return rows.map(({ subject, curriculum, curriculumId, group, trainingType, semester, educationYear }) => ({
    subject,
    curriculum,
    group,
    groups: group && Object.keys(group).length ? [group] : [],
    trainingType,
    semester,
    educationYear,
    educationLang: asRecord(group.educationLang),
    files:
      fileMap.get(
        calendarPlanFileMapKey({
          subjectId: textValue(subject.id) ?? "",
          curriculumId,
          semesterCode: textValue(semester.code),
          trainingTypeCode: textValue(trainingType.code),
        })
      ) || [],
    _subject: textValue(subject.id),
    _group: textValue(group.id),
    _curriculum: curriculumId,
    _training_type: textValue(trainingType.code),
    _semester: textValue(semester.code),
    _education_year: textValue(asRecord(educationYear).code),
    _education_lang: textValue(asRecord(group.educationLang).code),
  }))
}

function subjectTaskMatchesParams(item: unknown, params: Record<string, string>) {
  const record = asRecord(item)

  if (params._subject) {
    const subjectId = textValue(asRecord(record.subject).id)
    if (subjectId && subjectId !== params._subject) return false
  }

  if (params._training_type) {
    const trainingTypeCode = textValue(asRecord(record.trainingType).code)
    if (trainingTypeCode && trainingTypeCode !== params._training_type) return false
  }

  return true
}

function subjectTaskKey(record: Record<string, unknown>) {
  const taskType = asRecord(record.taskType)
  return [
    textValue(record.name, record.comment),
    textValue(taskType.code, taskType.name),
    textValue(record.deadline),
    textValue(record.max_ball),
  ].filter(Boolean).join("|")
}

function subjectTaskDetailItems(items: unknown[]) {
  const map = new Map<string, { record: Record<string, unknown>; total: number; answered: number; graded: number }>()

  items.forEach((item) => {
    const record = asRecord(item)
    const key = subjectTaskKey(record)
    if (!key) return

    const statusCode = textValue(asRecord(record.taskStatus).code)
    const mark = numberValue(asRecord(record.studentTaskActivity).mark)
    const answered = statusCode === "12" || statusCode === "13" ? 1 : 0
    const graded = statusCode === "13" || mark !== undefined ? 1 : 0

    const current = map.get(key)
    if (current) {
      current.total += 1
      current.answered += answered
      current.graded += graded
      return
    }
    map.set(key, { record, total: 1, answered, graded })
  })

  return Array.from(map.values()).map(({ record, total, answered, graded }) => {
    const taskType = asRecord(record.taskType)
    const files = Array.isArray(record.files) ? record.files : []
    const deadline = numberValue(record.deadline)

    return {
      id: record.id,
      name: record.name,
      comment: record.comment,
      taskType,
      max_ball: record.max_ball,
      deadline: record.deadline,
      deadline_label: formatUnixDateTime(record.deadline) ?? "-",
      file_count: files.length,
      students_total: total,
      students_answered: answered,
      students_graded: graded,
      students_label: `${answered}/${graded}/${total}`,
      active: !deadline || deadline * 1000 > Date.now(),
    }
  })
}

async function controlDashboardData(params: Record<string, string>, user?: AuthRequest["user"]) {
  const items = await controlItems(params, user)
  return items.reduce(
    (acc, item) => {
      acc[controlKind(item)] += 1
      return acc
    },
    { midterm: 0, final: 0, other: 0 }
  )
}

function itemCount(value: unknown) {
  if (Array.isArray(value)) return value.length
  const record = asRecord(value)
  const items = record.items
  if (Array.isArray(items)) return items.length
  return Object.keys(record).length ? 1 : 0
}

async function safeEmployeeDataCount(path: string, params: Record<string, string>, user?: AuthRequest["user"]) {
  try {
    return employeeDataTotal(path, params, user)
  } catch (err) {
    console.warn(`[HEMIS employee dashboard] ${path}:`, extractMessage(err))
    return 0
  }
}

async function employeeDashboardData(params: Record<string, string>, user?: AuthRequest["user"]) {
  const [attendanceJournal, schedule, lessonList, controls] = await Promise.all([
    attendanceJournalCount(params, user).catch((err) => {
      console.warn("[HEMIS employee dashboard] attendance journal:", extractMessage(err))
      return 0
    }),
    safeEmployeeDataCount("/v1/data/schedule-list", params, user),
    safeEmployeeDataCount("/v1/data/schedule-list", params, user),
    controlDashboardData(params, user).catch((err) => {
      console.warn("[HEMIS employee dashboard] controls:", extractMessage(err))
      return { midterm: 0, final: 0, other: 0 }
    }),
  ])

  return {
    lessons: {
      attendanceJournal,
      schedule,
      lessonList,
    },
    controls,
  }
}

async function employeeResourceData(
  resource: string,
  token: string,
  params: Record<string, string>,
  employeeBase = HEMIS_EMPLOYEE,
  user?: AuthRequest["user"]
) {
  if (resource === "dashboard") {
    return {
      data: await employeeDashboardData(params, user),
      source: "Backend API",
    }
  }

  if (resource === "document-signing") {
    return {
      data: [],
      source: "HEMIS e-hujjatlar",
    }
  }

  if (resource === "personal-plan") {
    return {
      data: [],
      source: "HEMIS shaxsiy ish reja",
    }
  }

  if (resource === "subject-resources") {
    return {
      data: await subjectResourcesForEmployee(params, user),
      source: "/v1/data/subject-file-resource-list",
    }
  }

  if (resource === "subject-topics") {
    return {
      data: await subjectTopicItems(params, user),
      source: "/v1/data/curriculum-subject-teacher-list",
      options: await subjectTopicOptions(params, user),
    }
  }

  if (resource === "subject-info") {
    return {
      data: await subjectTopicItems(params, user),
      source: "/v1/data/curriculum-subject-teacher-list",
      options: await subjectTopicOptions(params, user),
    }
  }

  if (resource === "subject-tasks") {
    return {
      data: await subjectTaskListItems(params, user),
      source: "/v1/data/curriculum-subject-teacher-list",
    }
  }

  if (resource === "subject-task-detail") {
    const items = (await employeeDataAllItems("/v1/data/subject-task-student-list", params, user))
      .filter((item) => itemMatchesEmployeeFilters(item, params))
      .filter((item) => subjectTaskMatchesParams(item, params))
    return {
      data: subjectTaskDetailItems(items),
      source: "/v1/data/subject-task-student-list",
    }
  }

  if (resource === "course-tasks") {
    return {
      data: await courseTaskListItems(params, user),
      source: "/v1/data/curriculum-subject-teacher-list",
    }
  }

  if (resource === "calendar-plan") {
    return {
      data: await calendarPlanListItems(params, user),
      source: "/v1/data/curriculum-subject-teacher-list",
    }
  }

  if (resource === "attendance-journal") {
    const items = (await employeeDataAllItems("/v1/data/attendance-control-list", params, user))
      .filter((item) => itemMatchesEmployeeFilters(item, params))
    return {
      data: attendanceJournalItems(items),
      source: "/v1/data/attendance-control-list",
    }
  }

  if (resource === "grade-journal") {
    const items = (await employeeDataAllItems("/v1/data/attendance-control-list", params, user))
      .filter((item) => itemMatchesEmployeeFilters(item, params))
    return {
      data: attendanceJournalItems(items),
      source: "/v1/data/attendance-control-list",
    }
  }

  if (resource === "attendance-records") {
    const groupId = textValue(params.group)
    if (!groupId) {
      return { data: [], source: "/v1/data/attendance-list" }
    }
    const subjectFilter = textValue(params.subject)?.trim().toLowerCase()
    const rawItems = await employeeDataAllItems(
      "/v1/data/attendance-list",
      { ...params, _group: groupId, limit: "200" },
      user
    )
    const items = rawItems
      .filter((item) => {
        if (!subjectFilter) return true
        const subject = asRecord(asRecord(item).subject)
        return textValue(subject.name)?.trim().toLowerCase() === subjectFilter
      })
      .map(normalizeAttendanceRecordItem)
      .filter((rec) => rec.lessonDate !== null && rec.studentUserId !== null)
    return {
      data: items,
      source: "/v1/data/attendance-list",
    }
  }

  if (resource === "grade-records") {
    const groupId = textValue(params.group)
    if (!groupId) {
      return { data: [], source: "/v1/data/student-grade-list" }
    }
    const subjectFilter = textValue(params.subject)?.trim().toLowerCase()
    const rawItems = await employeeDataAllItems(
      "/v1/data/student-grade-list",
      { ...params, _group: groupId, limit: "200" },
      user
    )
    const items = rawItems
      .filter((item) => {
        if (!subjectFilter) return true
        const subject = asRecord(asRecord(item).subject)
        return textValue(subject.name)?.trim().toLowerCase() === subjectFilter
      })
      .map(normalizeGradeRecordItem)
      .filter((rec) => rec.lessonDate !== null && rec.studentUserId !== null)
    return {
      data: items,
      source: "/v1/data/student-grade-list",
    }
  }

  if (resource === "midterm-controls" || resource === "final-controls" || resource === "other-controls") {
    const kindByResource = {
      "midterm-controls": "midterm",
      "final-controls": "final",
      "other-controls": "other",
    } as const
    const kind = kindByResource[resource]
    return {
      data: (await controlItems(params, user)).filter((item) => controlKind(item) === kind),
      source: "/v1/data/subject-exam-list",
    }
  }

  const paths = employeeResourcePaths[resource] ?? [`/v1/employee/${resource}`]
  const errors: string[] = []

  for (const path of paths) {
    const requestToken = path.startsWith("/v1/data/") && HEMIS_TOKEN ? HEMIS_TOKEN : token
    const requestBase = path.startsWith("/v1/data/") ? HEMIS_BASE : employeeBase
    const requestParams = path.startsWith("/v1/data/")
      ? employeeDataParams(path, params, user)
      : params
    try {
      const data = path.startsWith("/v1/data/") && requestToken === HEMIS_TOKEN
        ? await employeeDataAllItems(path, params, user)
        : await hemisGet(requestBase, path, requestToken, requestParams)
      return {
        data: unwrapHemisData(data),
        source: path,
      }
    } catch (err) {
      errors.push(`${path}: ${extractMessage(err)}`)
    }
  }

  const message = errors[0] || "HEMIS employee ma'lumotini olishda xatolik"
  throw new Error(message)
}

async function createStudentPasswordSession(login: string, password: string) {
  const normalizedPassword = password.trim()

  const { data } = await axios.post<{ success?: boolean; data?: { token: string }; message?: string }>(
    `${HEMIS}/v1/auth/login`,
    { login, password: normalizedPassword },
    { headers: { "Content-Type": "application/json", Accept: "application/json" } }
  )
  const hemisToken = data?.data?.token
  if (!hemisToken) {
    throw new Error(data?.message?.trim() || "Talaba login/paroli tasdiqlanmadi")
  }

  let profile: Record<string, unknown> = {}
  try {
    const profileData = await hemisGet(HEMIS, "/v1/account/me", hemisToken)
    profile = asRecord((profileData as any)?.data ?? profileData)
  } catch (profileErr) {
    console.warn("[HEMIS student login] Profil olishda xato:", extractMessage(profileErr))
  }

  return {
    success: true,
    token: signStudentToken(hemisToken, login, profile, "password"),
    role: "student" as const,
    source: "student-api",
  }
}

async function createEmployeePasswordSession(login: string, password: string) {
  const normalizedPassword = password.trim()
  let hemisToken = ""
  let employeeBase = HEMIS_EMPLOYEE
  let employeeProfilePath = "/ver1/tutor/profile/index"
  let employeeAuthMode: "password" | "tutor" = "tutor"
  const loginErrors: string[] = []

  for (const base of HEMIS_EMPLOYEE_LOGIN_BASES) {
    try {
      hemisToken = await tutorPasswordLogin(base, login, normalizedPassword)
      employeeBase = base
      employeeProfilePath = "/ver1/tutor/profile/index"
      employeeAuthMode = "tutor"
      break
    } catch (attemptErr) {
      loginErrors.push(`${base}/ver1/tutor/auth/login: ${extractMessage(attemptErr, "Login yoki parol noto'g'ri")}`)
    }
  }

  if (!hemisToken) {
    const err = Object.assign(
      new Error("Xodim login/paroli HEMIS Tutor API orqali tasdiqlanmadi"),
      {
        details: [
          "api.md bo'yicha /v1/auth/login faqat Student API uchun ishlaydi.",
          "Oddiy o'qituvchi/xodim paroli REST API orqali emas, HEMIS OAuth orqali tasdiqlanadi.",
          ...loginErrors,
        ],
      }
    )
    throw err
  }

  let profile: Record<string, unknown> = {}
  try {
    const profileData = await hemisGet(employeeBase, employeeProfilePath, hemisToken)
    const rawProfile = unwrapHemisData(profileData)
    const rawRecord = asRecord(rawProfile)
    profile = {
      ...asRecord(rawRecord.tutor),
      ...rawRecord,
      groups: Array.isArray(rawRecord.groups) ? rawRecord.groups : rawRecord.groups,
    }
  } catch (profileErr) {
    console.warn("[HEMIS employee login] Profil olishda xato:", extractMessage(profileErr))
  }

  if (Object.keys(profile).length && !employeeTypeAllowed(profile)) {
    throw new Error("Ushbu xodim turi uchun kirish ruxsat etilmagan")
  }

  return {
    success: true,
    token: signEmployeeToken(null, hemisToken, login, profile, employeeBase, employeeProfilePath, employeeAuthMode),
    role: "employee" as const,
    source: employeeAuthMode === "tutor" ? "tutor-api" : "employee-api",
  }
}

/* ── POST /api/hemis/login  (talaba) ─────────────────────────────── */
router.post("/login", async (req, res: Response) => {
  const { login, password } = req.body
  if (!login || !password) {
    res.status(400).json({ success: false, message: "Login va parol kerak" })
    return
  }
  try {
    const result = await createStudentPasswordSession(String(login).trim(), String(password))
    void saveUserToDb(result.token, "student")
    try {
      const decoded = JSON.parse(Buffer.from(result.token.split(".")[1], "base64").toString())
      const uid = Number(decoded.userId ?? decoded.id ?? 0)
      const gid = decoded.groupId ? Number(decoded.groupId) : null
      if (uid) void recordPlatformSession(uid, String(decoded.fullName ?? login), gid, "student")
    } catch { /* session yozishda xato — login ishlayversin */ }
    res.json(result)
  } catch (err) {
    const e = err as AxiosError<{ message?: string }>
    console.error("[HEMIS student login]", e?.response?.status, e?.response?.data)
    res.status(401).json({ success: false, message: extractMessage(err, "Login yoki parol noto'g'ri") })
  }
})

/* ── POST /api/hemis/employee-login  (xodim) ─────────────────────── */
router.post("/employee-login", async (req, res: Response) => {
  const { login, password } = req.body
  if (!login || !password) {
    res.status(400).json({ success: false, message: "Login va parol kerak" })
    return
  }
  try {
    const result = await createEmployeePasswordSession(String(login).trim(), String(password))
    void saveUserToDb(result.token, "employee")
    void syncTeacherFromHemis(result.token)  // syncTeacherFromHemis sessiyani to'g'ri ID bilan yozadi
    res.json(result)
  } catch (err) {
    const e = err as AxiosError<{ message?: string }>
    console.error("[HEMIS employee login]", e?.response?.status, e?.response?.data)
    res.status(401).json({
      success: false,
      message: extractMessage(err, "Login yoki parol noto'g'ri"),
      details: (err as { details?: unknown }).details,
    })
  }
})

/* ── POST /api/hemis/auto-login  (talaba/xodimni avtomatik aniqlash) ─ */
router.post("/auto-login", async (req, res: Response) => {
  const login = textValue(req.body?.login)
  const password = typeof req.body?.password === "string" ? req.body.password : undefined
  if (!login || !password) {
    res.status(400).json({ success: false, message: "Login va parol kerak" })
    return
  }

  const details: string[] = []
  try {
    const result = await createStudentPasswordSession(login, password)
    void saveUserToDb(result.token, "student")
    res.json(result)
    return
  } catch (err) {
    details.push(`Talaba API: ${extractMessage(err, "Login yoki parol noto'g'ri")}`)
  }

  try {
    const result = await createEmployeePasswordSession(login, password)
    void saveUserToDb(result.token, "employee")
    void syncTeacherFromHemis(result.token)
    res.json(result)
    return
  } catch (err) {
    details.push(`Xodim/Tutor API: ${extractMessage(err, "Login yoki parol noto'g'ri")}`)
    const nested = (err as { details?: unknown }).details
    if (Array.isArray(nested)) {
      details.push(...nested.map((item) => String(item)).slice(0, 6))
    }
  }

  res.status(409).json({
    success: false,
    oauthRequired: true,
    message: "Xodim yoki o'qituvchi HEMIS OAuth orqali kirishi kerak",
    details: process.env.NODE_ENV === "development" ? details : undefined,
  })
})

/* ── HEMIS OAuth: client ID/client code orqali kirish ─────────────── */
router.get("/oauth/url", (req, res: Response) => {
  const role = normalizeOAuthRole(req.query.role) || "auto"
  if (!role) {
    res.status(400).json({ success: false, message: "role student, employee yoki auto bo'lishi kerak" })
    return
  }
  if (!HEMIS_OAUTH_CLIENT_ID || !HEMIS_OAUTH_CLIENT_SECRET) {
    res.status(500).json({ success: false, message: "HEMIS OAuth client ID yoki client code sozlanmagan" })
    return
  }

  const redirectUri = normalizeRedirectUri(req.query.redirectUri, role)
  const state = createOAuthState(role, redirectUri)
  const url = buildOAuthAuthorizeUrl(role, redirectUri, state)
  res.json({ success: true, url: url.toString(), state, redirectUri })
})

router.get("/oauth/config", (req, res: Response) => {
  const role = normalizeOAuthRole(req.query.role) || "employee"
  const configRole: OAuthRole = role === "auto" ? "employee" : role
  const redirectUri = configuredOAuthRedirectUri(configRole)
  const serverRedirectUri = serverOAuthRedirectUri(configRole)
  res.json({
    success: true,
    role: configRole,
    configured: Boolean(oauthClientIdForRole(configRole) && oauthClientSecretForRole(configRole)),
    clientId: oauthClientIdForRole(configRole) || null,
    authorizeUrl: `${oauthBaseForRole(configRole)}/oauth/authorize`,
    accessTokenUrl: `${oauthBaseForRole(configRole)}/oauth/access-token`,
    userUrl: `${oauthBaseForRole(configRole)}/oauth/api/user`,
    redirectUri,
    serverRedirectUri,
    requiredHemisClientUrls: [
      redirectUri,
      serverRedirectUri,
      stripTrailingSlash(FRONTEND_URL),
    ],
  })
})

router.get("/oauth/start/:role", (req, res: Response) => {
  const requestedRole = normalizeOAuthRole(req.params.role) || "employee"
  if (requestedRole === "auto") {
    res.status(400).json({ success: false, message: "OAuth start uchun role employee yoki student bo'lishi kerak" })
    return
  }
  if (!HEMIS_OAUTH_CLIENT_ID || !HEMIS_OAUTH_CLIENT_SECRET) {
    res.status(500).json({ success: false, message: "HEMIS OAuth client ID yoki client code sozlanmagan" })
    return
  }

  const redirectUri = configuredOAuthRedirectUri(requestedRole)
  const expectedLogin = textValue(req.query.login, req.query.expectedLogin)
  const state = createOAuthState(requestedRole, redirectUri, expectedLogin)
  res.redirect(buildOAuthAuthorizeUrl(requestedRole, redirectUri, state).toString())
})

router.get("/oauth/:role", async (req, res: Response) => {
  const requestedRole = normalizeOAuthRole(req.params.role) || "employee"
  if (requestedRole === "auto") {
    res.status(400).json({ success: false, message: "Server-side OAuth uchun role employee yoki student bo'lishi kerak" })
    return
  }
  if (!HEMIS_OAUTH_CLIENT_ID || !HEMIS_OAUTH_CLIENT_SECRET) {
    res.status(500).json({ success: false, message: "HEMIS OAuth client ID yoki client code sozlanmagan" })
    return
  }

  const redirectUri = configuredOAuthRedirectUri(requestedRole)
  const oauthError = textValue(req.query.error)
  const oauthDescription = textValue(req.query.error_description, req.query.message)
  if (oauthError) {
    const callbackUrl = new URL("/login/oauth/callback", FRONTEND_URL)
    callbackUrl.searchParams.set("error", oauthError)
    if (oauthDescription) callbackUrl.searchParams.set("message", oauthDescription)
    res.redirect(callbackUrl.toString())
    return
  }

  const code = oauthCodeValue(req.query.code)
  if (!code) {
    res.redirect(buildOAuthAuthorizeUrl(requestedRole, redirectUri, createOAuthState(requestedRole, redirectUri)).toString())
    return
  }

  const statePayload = readOAuthState(req.query.state, requestedRole, redirectUri)
  if (!statePayload) {
    const callbackUrl = new URL("/login/oauth/callback", FRONTEND_URL)
    callbackUrl.searchParams.set("error", "invalid_state")
    callbackUrl.searchParams.set("message", "HEMIS OAuth state yaroqsiz yoki eskirgan")
    res.redirect(callbackUrl.toString())
    return
  }

  try {
    const result = await createOAuthSession(requestedRole, code, redirectUri, statePayload.expectedLogin)
    void saveUserToDb(result.token, result.role)
    void syncTeacherFromHemis(result.token)
    const callbackUrl = new URL("/login/oauth/callback", FRONTEND_URL)
    callbackUrl.searchParams.set("token", result.token)
    callbackUrl.searchParams.set("role", result.role)
    res.redirect(callbackUrl.toString())
  } catch (err) {
    console.error("[HEMIS oauth redirect]", extractMessage(err), (err as AxiosError)?.response?.data)
    const callbackUrl = new URL("/login/oauth/callback", FRONTEND_URL)
    callbackUrl.searchParams.set("error", "oauth_failed")
    callbackUrl.searchParams.set("message", extractMessage(err, "HEMIS OAuth orqali kirishda xatolik"))
    const details = (err as { details?: unknown }).details
    if (Array.isArray(details) && details.length) {
      callbackUrl.searchParams.set("details", details.map(String).join("; "))
    }
    res.redirect(callbackUrl.toString())
  }
})

router.post("/oauth/callback", async (req, res: Response) => {
  const requestedRole = normalizeOAuthRole(req.body?.role) || "auto"
  const code = oauthCodeValue(req.body?.code)
  const redirectUri = normalizeRedirectUri(req.body?.redirectUri, requestedRole)
  if (!code) {
    res.status(400).json({ success: false, message: "OAuth code kerak" })
    return
  }
  const statePayload = readOAuthState(req.body?.state, requestedRole, redirectUri)
  if (!statePayload) {
    res.status(400).json({ success: false, message: "OAuth state yaroqsiz yoki eskirgan" })
    return
  }

  try {
    const result = await createOAuthSession(requestedRole, code, redirectUri, statePayload.expectedLogin)
    void saveUserToDb(result.token, result.role)
    void syncTeacherFromHemis(result.token)
    res.json({ success: true, ...result })
  } catch (err) {
    console.error("[HEMIS oauth]", extractMessage(err), (err as AxiosError)?.response?.data)
    res.status(401).json({
      success: false,
      message: extractMessage(err, "HEMIS OAuth orqali kirishda xatolik"),
      details: (err as { details?: unknown }).details,
    })
  }
})

/* ── GET /api/hemis/download  (token-authenticated file proxy) ───── */
// Placed BEFORE authMiddleware so browser <a href> can pass token as query param
router.get("/download", async (req, res: Response) => {
  // Accept token from query param (needed for browser <a href> downloads)
  const rawToken = String(req.query.token ?? "").trim()
  let hemisToken: string | null = null
  if (rawToken) {
    try {
      const decoded = jwt.verify(rawToken, JWT_SECRET) as { hemisToken?: string }
      hemisToken = decoded.hemisToken ?? null
    } catch {
      res.status(401).json({ success: false, message: "Token yaroqsiz" })
      return
    }
  }
  if (!hemisToken) {
    res.status(401).json({ success: false, message: "HEMIS token topilmadi" })
    return
  }
  const fileUrl = String(req.query.url ?? "").trim()
  const suggestedName = String(req.query.filename ?? "file").trim()
  if (!fileUrl) {
    res.status(400).json({ success: false, message: "url parametri kerak" })
    return
  }
  try {
    const response = await axios.get(fileUrl, {
      responseType: "stream",
      headers: {
        Authorization: `Bearer ${hemisToken}`,
        "access-token": hemisToken,
        Accept: "*/*",
      },
      maxRedirects: 5,
    })
    const contentType = response.headers["content-type"]
    const ct = typeof contentType === "string" ? contentType : "application/octet-stream"
    const filename = suggestedName || fileUrl.split("/").pop()?.split("?")[0] || "file"
    res.setHeader("Content-Type", ct)
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    const contentLength = response.headers["content-length"]
    if (typeof contentLength === "string" || typeof contentLength === "number") {
      res.setHeader("Content-Length", contentLength)
    }
    response.data.pipe(res)
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/download-zip  (bir nechta faylni zip qilib yuklash) ── */
// Placed BEFORE authMiddleware so browser <a href> can pass token as query param
router.get("/download-zip", async (req, res: Response) => {
  const rawToken = String(req.query.token ?? "").trim()
  let hemisToken: string | null = null
  if (rawToken) {
    try {
      const decoded = jwt.verify(rawToken, JWT_SECRET) as { hemisToken?: string }
      hemisToken = decoded.hemisToken ?? null
    } catch {
      res.status(401).json({ success: false, message: "Token yaroqsiz" })
      return
    }
  }
  if (!hemisToken) {
    res.status(401).json({ success: false, message: "HEMIS token topilmadi" })
    return
  }

  let files: Array<{ url?: string; name?: string }> = []
  try {
    const parsed = JSON.parse(String(req.query.files ?? "[]"))
    if (Array.isArray(parsed)) files = parsed
  } catch {
    res.status(400).json({ success: false, message: "files parametri noto'g'ri" })
    return
  }
  files = files.filter((f) => typeof f?.url === "string" && f.url)
  if (!files.length) {
    res.status(400).json({ success: false, message: "files parametri kerak" })
    return
  }

  const zipName = String(req.query.filename ?? "fayllar.zip").trim() || "fayllar.zip"

  res.setHeader("Content-Type", "application/zip")
  res.setHeader("Content-Disposition", `attachment; filename="${zipName.replace(/"/g, "")}"`)

  const archive = archiver("zip", { zlib: { level: 9 } })
  archive.on("error", () => {
    if (!res.headersSent) res.status(502)
    res.end()
  })
  archive.pipe(res)

  const usedNames = new Set<string>()
  for (const file of files) {
    try {
      const response = await axios.get(file.url as string, {
        responseType: "stream",
        headers: {
          Authorization: `Bearer ${hemisToken}`,
          "access-token": hemisToken,
          Accept: "*/*",
        },
        maxRedirects: 5,
      })
      const baseName = file.name || (file.url as string).split("/").pop()?.split("?")[0] || "file"
      let finalName = baseName
      let counter = 1
      while (usedNames.has(finalName)) {
        const dotIdx = baseName.lastIndexOf(".")
        finalName = dotIdx > 0 ? `${baseName.slice(0, dotIdx)} (${counter})${baseName.slice(dotIdx)}` : `${baseName} (${counter})`
        counter++
      }
      usedNames.add(finalName)
      archive.append(response.data, { name: finalName })
    } catch {
      // fayl olib bo'lmadi, o'tkazib yuborildi
    }
  }
  await archive.finalize()
})

/* ── GET /api/hemis/calendar-plan-pdf  (HEMIS teacher kabineti PDF) ── */
// Placed BEFORE authMiddleware so browser <a href> can pass token as query param.
// HEMIS'ning https://hemis.sies.uz/teacher/calendar-plan?...&download=1 sahifasini
// access-token bilan proksi qilib, "Calendar_plan-<Fan>.pdf" faylini qaytaradi.
router.get("/calendar-plan-pdf", async (req, res: Response) => {
  const rawToken = String(req.query.token ?? "").trim()
  let hemisToken: string | null = null
  if (rawToken) {
    try {
      const decoded = jwt.verify(rawToken, JWT_SECRET) as { hemisToken?: string }
      hemisToken = decoded.hemisToken ?? null
    } catch {
      res.status(401).json({ success: false, message: "Token yaroqsiz" })
      return
    }
  }
  if (!hemisToken) {
    res.status(401).json({ success: false, message: "HEMIS token topilmadi" })
    return
  }

  const passthroughParams = ["curriculum", "semester", "educationYear", "subject", "group", "training_type", "education_lang"]
  const targetParams = new URLSearchParams()
  for (const key of passthroughParams) {
    const value = req.query[key]
    if (typeof value === "string" && value) targetParams.set(key, value)
  }
  if (!targetParams.has("curriculum") || !targetParams.has("subject")) {
    res.status(400).json({ success: false, message: "curriculum va subject parametrlari kerak" })
    return
  }
  targetParams.set("download", "1")

  const filename = (String(req.query.filename ?? "").trim() || "Calendar_plan.pdf").replace(/"/g, "")

  try {
    const response = await axios.get(`${HEMIS_OAUTH_EMPLOYEE_BASE}/teacher/calendar-plan?${targetParams.toString()}`, {
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${hemisToken}`,
        "access-token": hemisToken,
        Accept: "*/*",
      },
      maxRedirects: 5,
      validateStatus: () => true,
    })
    const buffer = Buffer.from(response.data)
    const isPdf = buffer.subarray(0, 5).toString("latin1") === "%PDF-"
    if (!isPdf) {
      const contentType = String(response.headers["content-type"] ?? "")
      let message = `HEMIS PDF qaytarmadi (status ${response.status}, content-type: ${contentType || "noma'lum"})`
      if (contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(buffer.toString("utf-8"))
          message = parsed?.message || message
        } catch {
          // ignore parse errors
        }
      }
      res.status(502).json({ success: false, message })
      return
    }
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Content-Length", buffer.length)
    res.send(buffer)
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── barcha keyingi route'lar JWT talab qiladi ───────────────────── */
router.use(authMiddleware)

function getHemisToken(req: AuthRequest, res: Response): string | null {
  const token = req.user?.hemisToken
  if (!token) {
    res.status(401).json({ success: false, message: "HEMIS token topilmadi" })
    return null
  }
  return token
}

/* ── GET /api/hemis/me  (talaba profili) ──────────────────────────── */
router.get("/me", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "me",
      () => hemisGet(HEMIS, "/v1/account/me", hToken), TTL_24H)
    res.json({ success: true, data: (r.data as any)?.data ?? r.data, source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/employee-me  (xodim profili) ─────────────────── */
router.get("/employee-me", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  if (req.user?.employeeProfile) {
    res.json({ success: true, data: req.user.employeeProfile, source: "token" })
    return
  }
  const employeeBase = req.user?.employeeHemisBase || HEMIS_EMPLOYEE
  const employeeProfilePath = req.user?.employeeProfilePath || "/v1/account/me"
  try {
    const r = await withHemisCache(reqUserId(req), "employee-me",
      () => hemisGet(employeeBase, employeeProfilePath, hToken), TTL_24H)
    res.json({ success: true, data: (r.data as any)?.data ?? r.data, source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/semesters ────────────────────────────────────── */
router.get("/employee/:resource", async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== "employee" && req.user?.role !== "teacher") {
    res.status(403).json({ success: false, message: "O'qituvchi ma'lumotlari uchun ruxsat yo'q" })
    return
  }

  const hToken = getHemisToken(req, res)
  if (!hToken) return

  try {
    const resource = String(req.params.resource || "").trim()
    const result = await employeeResourceData(
      resource,
      hToken,
      collectStringParams(req.query),
      req.user?.employeeHemisBase || HEMIS_EMPLOYEE,
      req.user
    )
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

router.get("/semesters", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "semesters",
      () => hemisGet(HEMIS, "/v1/education/semesters", hToken), TTL_24H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/schedule ─────────────────────────────────────── */
// Student API: /v1/education/schedule  (NOT /v1/data/schedule-list which is Backend API)
router.get("/schedule", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const week = req.query._week || req.query.week
    const semester = req.query._semester || req.query.semester
    if (week)     params.week     = String(week)
    if (semester) params.semester = String(semester)
    const cacheKey = `schedule:${semester ?? "all"}:${week ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/schedule", hToken, params), TTL_1H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/attendance ───────────────────────────────────── */
// Student API: /v1/education/attendance  (NOT /v1/data/attendance-list which is Backend API)
router.get("/attendance", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester)          params.semester = String(semester)
    if (req.query.subject) params.subject  = String(req.query.subject)
    const cacheKey = `attendance:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/attendance", hToken, params), TTL_1H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/grades ───────────────────────────────────────── */
// Student API: /v1/education/subject-list  (NOT /v1/data/academic-record-list which is Backend API)
// Maps StudentSubjectMeta → HemisGrade format for frontend compatibility
router.get("/grades", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester) params.semester = String(semester)
    const cacheKey = `grades:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/subject-list", hToken, params), TTL_1H)
    const items: any[] = (r.data as any)?.data ?? []
    const mapped = items.map((item: any) => {
      const cs = item.curriculumSubject ?? {}
      const score = item.overallScore ?? {}
      const totalPoint = score.grade ?? cs.student_ball ?? cs.subject_ball ?? 0
      return {
        id:                   cs.subject?.id ?? item._semester,
        subject_name:         cs.subject?.name ?? "",
        subject_code:         cs.subject?.code ?? "",
        subject_type:         cs.subjectType?.name ?? "",
        employee_name:        cs.employee?.name ?? "",
        semester_name:        item._semester ?? "",
        total_acload:         cs.total_acload ?? 0,
        credit:               cs.credit ?? 0,
        total_point:          totalPoint,
        grade:                score.grade ?? null,
        finish_credit_status: totalPoint >= 55,
        retraining_status:    totalPoint > 0 && totalPoint < 55,
        _semester:            item._semester ?? "",
        _education_year:      "",
      }
    })
    res.json({ success: true, data: mapped, source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/performance ──────────────────────────────────── */
// Student API: /v1/education/performance  (NOT /v1/data/student-performance-list)
router.get("/performance", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester)          params.semester = String(semester)
    if (req.query.subject) params.subject  = String(req.query.subject)
    const cacheKey = `performance:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/performance", hToken, params), TTL_1H)
    res.json({ success: true, data: (r.data as any)?.data ?? null, source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/gpa ──────────────────────────────────────────── */
// Student API: /v1/education/gpa-list  (NOT /v1/data/student-gpa-list)
router.get("/gpa", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "gpa",
      () => hemisGet(HEMIS, "/v1/education/gpa-list", hToken), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/billing ──────────────────────────────────────── */
// Student API: /v1/billing/all  ✓ (already correct)
router.get("/billing", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    if (req.query.eduYear) params.eduYear = String(req.query.eduYear)
    const cacheKey = `billing:${req.query.eduYear ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/billing/all", hToken, params), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? r.data, source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/exams ────────────────────────────────────────── */
// Student API: /v1/education/exam-table  (NOT /v1/data/exam-list which is Backend API)
router.get("/exams", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester) params.semester = String(semester)
    const cacheKey = `exams:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/exam-table", hToken, params), TTL_1H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── POST /api/hemis/task-submit ─────────────────────────────────── */
// Hozircha HEMIS ga yubormaydi — faylni o'z serverimizda saqlaymiz.
// Keyin tayyor bo'lganda bu yerga HEMIS ga yuborish qo'shiladi.
router.post("/task-submit", async (req: AuthRequest, res: Response) => {
  const { task_id, comment, filename, file_type, file_data } = req.body
  if (!task_id || !file_data || !filename) {
    res.status(400).json({ success: false, message: "task_id, filename va file_data kerak" })
    return
  }
  try {
    const buffer    = Buffer.from(String(file_data), "base64")
    const mimeType  = String(file_type || "application/octet-stream")
    const savedName = sanitizeFilename(String(filename))
    const dir       = path.join(submissionUploadsDir(), "hemis")
    fs.mkdirSync(dir, { recursive: true })
    const absPath    = path.join(dir, savedName)
    fs.writeFileSync(absPath, buffer)

    const relativePath  = path.join("submissions", "hemis", savedName).replace(/\\/g, "/")
    const studentId     = studentUserId(req.user)
    const studentName   = String(req.user?.fullName ?? req.user?.username ?? "")
    const groupId       = req.user?.groupId ? Number(req.user.groupId) : null

    await pool.query(
      `INSERT INTO lms_hemis_task_submissions
         (hemis_task_id, student_user_id, student_full_name, group_id,
          file_name, original_name, mime_type, file_size, relative_path, comment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         file_name      = VALUES(file_name),
         original_name  = VALUES(original_name),
         mime_type      = VALUES(mime_type),
         file_size      = VALUES(file_size),
         relative_path  = VALUES(relative_path),
         comment        = VALUES(comment),
         submitted_at   = CURRENT_TIMESTAMP`,
      [
        String(task_id),
        studentId,
        studentName,
        groupId,
        savedName,
        String(filename),
        mimeType,
        buffer.byteLength,
        relativePath,
        comment ? String(comment) : null,
      ]
    )

    res.json({ success: true, data: { message: "Topshiriq saqlandi" } })
  } catch (err) {
    res.status(500).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/task-submissions — o'qituvchi: topshiriq natijalari ── */
router.get("/task-submissions", async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi ko'ra oladi" })
    return
  }
  try {
    const taskId  = req.query.taskId  ? String(req.query.taskId)  : null
    const groupId = req.query.groupId ? Number(req.query.groupId) : null

    const where: string[] = []
    const params: unknown[] = []
    if (taskId)  { where.push("hemis_task_id = ?"); params.push(taskId) }
    if (groupId) { where.push("group_id = ?");      params.push(groupId) }

    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT id, hemis_task_id, student_user_id, student_full_name, group_id,
              file_name, original_name, mime_type, file_size, comment, submitted_at
       FROM lms_hemis_task_submissions
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY submitted_at DESC`,
      params
    )
    const data = rows.map(r => ({
      id:            Number(r.id),
      hemisTaskId:   String(r.hemis_task_id),
      studentUserId: Number(r.student_user_id),
      studentName:   String(r.student_full_name),
      groupId:       r.group_id != null ? Number(r.group_id) : null,
      fileName:      r.file_name ? String(r.file_name) : null,
      originalName:  r.original_name ? String(r.original_name) : null,
      mimeType:      r.mime_type ? String(r.mime_type) : null,
      fileSize:      r.file_size ? Number(r.file_size) : null,
      comment:       r.comment ? String(r.comment) : null,
      submittedAt:   r.submitted_at instanceof Date ? r.submitted_at.toISOString() : String(r.submitted_at),
      downloadUrl:   r.file_name
        ? `/api/hemis/task-submission-file/${encodeURIComponent(String(r.file_name))}`
        : null,
    }))
    res.json({ success: true, data })
  } catch (err) {
    res.status(500).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/task-submission-file/:filename — fayl yuklab olish ── */
router.get("/task-submission-file/:filename", async (req: AuthRequest, res: Response) => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi ko'ra oladi" })
    return
  }
  try {
    const fname   = String(req.params.filename)
    const absPath = path.join(submissionUploadsDir(), "hemis", fname)
    if (!fs.existsSync(absPath)) {
      res.status(404).json({ success: false, message: "Fayl topilmadi" })
      return
    }
    const [row] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT original_name, mime_type FROM lms_hemis_task_submissions WHERE file_name = ? LIMIT 1",
      [fname]
    )
    const originalName = row[0]?.original_name ?? fname
    const mimeType     = row[0]?.mime_type ?? "application/octet-stream"
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(String(originalName))}"`)
    res.setHeader("Content-Type", String(mimeType))
    res.sendFile(absPath)
  } catch (err) {
    res.status(500).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/tasks ────────────────────────────────────────── */
router.get("/tasks", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester) params.semester = String(semester)
    const cacheKey = `tasks:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/task-list", hToken, params), TTL_1H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/contract-list ────────────────────────────────── */
router.get("/contract-list", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "contract-list",
      () => hemisGet(HEMIS, "/v1/student/contract-list", hToken), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? r.data, source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/decree ───────────────────────────────────────── */
router.get("/decree", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "decree",
      () => hemisGet(HEMIS, "/v1/student/decree", hToken), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/documents ────────────────────────────────────── */
router.get("/documents", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "documents",
      () => hemisGet(HEMIS, "/v1/student/document-all", hToken), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/reference ────────────────────────────────────── */
router.get("/reference", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "reference",
      () => hemisGet(HEMIS, "/v1/student/reference", hToken), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/resources ────────────────────────────────────── */
router.get("/resources", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  const localResources = await localResourcesAsHemisResources()
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester) params.semester = String(semester)
    const cacheKey = `resources:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/resources", hToken, params), TTL_1H)
    res.json({ success: true, data: [...((r.data as any)?.data ?? []), ...localResources], source: r.source })
  } catch (err) {
    if (localResources.length) {
      res.json({ success: true, data: localResources, source: "local-fallback" })
      return
    }
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/certificate ─────────────────────────────────── */
router.get("/certificate", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const r = await withHemisCache(reqUserId(req), "certificate",
      () => hemisGet(HEMIS, "/v1/student/certificate", hToken), TTL_4H)
    res.json({ success: true, data: (r.data as any)?.data ?? [], source: r.source })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

/* ── GET /api/hemis/absence ──────────────────────────────────────── */
router.get("/absence", async (req: AuthRequest, res: Response) => {
  const hToken = getHemisToken(req, res)
  if (!hToken) return
  try {
    const params: Record<string, string> = {}
    const semester = req.query._semester || req.query.semester
    if (semester) params.semester = String(semester)
    const cacheKey = `absence:${semester ?? "all"}`
    const r = await withHemisCache(reqUserId(req), cacheKey,
      () => hemisGet(HEMIS, "/v1/education/attendance", hToken, params), TTL_1H)
    const items: any[] = (r.data as any)?.data ?? []
    const absent_with    = items.reduce((s: number, i: any) => s + (Number(i.absent_on)  || 0), 0)
    const absent_without = items.reduce((s: number, i: any) => s + (Number(i.absent_off) || 0), 0)
    res.json({
      success: true, source: r.source,
      data: { absent_with_reason: absent_with, absent_without_reason: absent_without, total_absent: absent_with + absent_without },
    })
  } catch (err) {
    res.status(502).json({ success: false, message: extractMessage(err) })
  }
})

export default router
