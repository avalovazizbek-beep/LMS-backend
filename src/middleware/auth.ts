import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"

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
