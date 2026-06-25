import { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"

export interface AuthUser {
  id?: string | number
  userId?: string | number
  username?: string
  fullName?: string
  role: string
  hemisToken?: string
  studentAuthMode?: "password" | "oauth"
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
