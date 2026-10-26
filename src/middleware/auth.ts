import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import type { RowDataPacket } from "mysql2"
import { pool } from "../services/db"

export interface AuthUser {
  id?: string | number
  userId?: string | number
  username?: string
  // The actual HEMIS login/ID typed at sign-in — stable across devices and
  // sessions, unlike `username` (which is display-name-derived and can vary
  // in formatting between HEMIS API responses). Use this for anything that
  // needs to recognize the same person across logins, e.g. face_registrations.
  hemisLogin?: string
  fullName?: string
  role: string
  hemisToken?: string
  studentAuthMode?: "password" | "oauth"
  // OAuth orqali kirgan talaba uchun HEMIS'dan kelgan to'liq profil —
  // shu talabaning OAuth access_token'i HEMIS Student REST API'ning
  // /v1/account/me kabi endpointlarini tan olmaydi, shuning uchun profil
  // qayta so'ralmasdan shu yerdan (token ichidan) o'qiladi.
  studentProfile?: Record<string, unknown>
  isEmployee?: boolean
  employeeHemisBase?: string
  employeeProfilePath?: string
  employeeAuthMode?: "password" | "tutor" | "oauth"
  employeeProfile?: Record<string, unknown>
  groupId?: string | number | null
  teacherGroupIds?: Array<string | number>
}

export interface AuthRequest extends Request {
  user?: AuthUser
}

// BH-M-425 talabalariga ilgari qattiq yozilgan 425 guruh ID'si berilardi
// (haqiqiysi HEMIS'da boshqa). 30 kunlik eski tokenlarda hali shu qiymat
// turibdi — qayta kirishni kutmasdan haqiqiy ID'ga almashtiriladi: avval
// token ichidagi OAuth profilidan, bo'lmasa HEMIS katalogidan.
const LEGACY_GROUP_ID = 425
const legacyGroupCache = new Map<string, number | null>()

async function fixLegacyGroupId(user: AuthUser): Promise<void> {
  const group = user.studentProfile?.group as Record<string, unknown> | undefined
  const fromProfile = Number(group?.id ?? user.studentProfile?.group_id)
  if (Number.isFinite(fromProfile) && fromProfile > 0) {
    user.groupId = fromProfile
    return
  }
  const key = String(user.id ?? user.hemisLogin ?? "")
  if (!key) return
  if (!legacyGroupCache.has(key)) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT group_id FROM hemis_students_directory WHERE hemis_id = ? OR student_id_number = ? LIMIT 1",
      [Number(user.id) || 0, String(user.hemisLogin ?? "")]
    )
    legacyGroupCache.set(key, rows[0]?.group_id != null ? Number(rows[0].group_id) : null)
  }
  const fromDirectory = legacyGroupCache.get(key)
  if (fromDirectory) user.groupId = fromDirectory
}

function hasLegacyGroupId(user: AuthUser) {
  return user.role === "student" && Number(user.groupId) === LEGACY_GROUP_ID
}

/** Tokenni middleware'siz tekshiradigan joylar (fayl havolalari) uchun */
export async function withFixedGroupId(user: AuthUser): Promise<AuthUser> {
  if (hasLegacyGroupId(user)) await fixLegacyGroupId(user).catch(() => {})
  return user
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  // Also accept token from query string for <img src> / <video src> / <a href> use-cases
  const queryToken = typeof req.query?.token === "string" ? req.query.token : undefined

  const raw = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : queryToken
  if (!raw) {
    res.status(401).json({ success: false, message: "Token topilmadi" })
    return
  }

  try {
    const decoded = jwt.verify(raw, process.env.JWT_SECRET || "secret") as AuthUser
    req.user = decoded
    if (hasLegacyGroupId(decoded)) {
      void withFixedGroupId(decoded).then(() => next())
      return
    }
    next()
  } catch {
    res.status(401).json({ success: false, message: "Token yaroqsiz" })
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: "Ruxsat yo'q" })
      return
    }
    next()
  }
}
