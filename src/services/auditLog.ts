import type { RowDataPacket } from "mysql2"
import { pool } from "./db"
import type { AuthRequest } from "../middleware/auth"

function clientIp(req: AuthRequest): string | null {
  const fwd = req.headers["x-forwarded-for"]
  if (typeof fwd === "string" && fwd.trim()) return fwd.split(",")[0].trim()
  if (Array.isArray(fwd) && fwd.length) return fwd[0]
  return req.ip ?? req.socket?.remoteAddress ?? null
}

function actorHemisId(req: AuthRequest): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.username ?? "")
}

/** Admin panelidagi sezilarli amalni (rol o'zgartirish, sozlama saqlash va h.k.)
    kim, qaysi IP'dan bajarganini yozib boradi. Yozishda xato bo'lsa ham asosiy
    amal to'xtamaydi (audit log ikkinchi darajali — faqat log qilinadi). */
export async function logAudit(
  req: AuthRequest,
  action: string,
  module: string | null,
  target?: string | null,
  detail?: Record<string, unknown> | null
): Promise<void> {
  try {
    const hemisId = actorHemisId(req)
    if (!hemisId) return
    await pool.query(
      `INSERT INTO lms_audit_log (actor_hemis_id, actor_name, actor_role, action, module, target, detail, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        hemisId,
        req.user?.fullName ?? null,
        req.user?.role ?? null,
        action,
        module ?? null,
        target ?? null,
        detail ? JSON.stringify(detail) : null,
        clientIp(req),
        typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      ]
    )
  } catch (err) {
    console.warn("[audit] yozishda xato:", err instanceof Error ? err.message : err)
  }
}

export interface AuditLogRow {
  id: number
  actorHemisId: string
  actorName: string | null
  actorRole: string | null
  action: string
  module: string | null
  target: string | null
  detail: unknown
  ipAddress: string | null
  userAgent: string | null
  createdAt: string
}

export async function listAuditLog(params: { limit?: number; actorHemisId?: string; module?: string }): Promise<AuditLogRow[]> {
  const where: string[] = []
  const args: unknown[] = []
  if (params.actorHemisId) { where.push("actor_hemis_id = ?"); args.push(params.actorHemisId) }
  if (params.module) { where.push("module = ?"); args.push(params.module) }
  const limit = Math.min(params.limit ?? 100, 500)
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM lms_audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
    [...args, limit]
  )
  return rows.map((r) => ({
    id: Number(r.id),
    actorHemisId: String(r.actor_hemis_id),
    actorName: r.actor_name ?? null,
    actorRole: r.actor_role ?? null,
    action: String(r.action),
    module: r.module ?? null,
    target: r.target ?? null,
    detail: r.detail ? (typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail) : null,
    ipAddress: r.ip_address ?? null,
    userAgent: r.user_agent ?? null,
    createdAt: String(r.created_at),
  }))
}
