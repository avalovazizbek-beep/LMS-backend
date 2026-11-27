import type { RowDataPacket } from "mysql2"
import { pool } from "./db"

export const ADMIN_MODULES = [
  "users", "students", "teachers", "results", "attendance",
  "grading", "retake", "reedu", "faceid", "announcements", "surveys", "settings", "permissions",
] as const
export type AdminModule = typeof ADMIN_MODULES[number]

export type PermissionAction = "view" | "create" | "edit" | "delete"

/** Admin paneliga kiradigan, huquqlari Ruxsatlar sahifasida sozlanadigan rollar.
    2026-11-27: dekanatdan tashqari prorektor, ta'lim sifati va o'quv-uslubiy
    bo'lim qo'shildi (HEMIS'da bular rol emas — lavozim/bo'lim; rolni admin beradi). */
export const MANAGED_ROLES = ["dean", "prorector", "quality", "methodist"] as const
export type ManagedRole = typeof MANAGED_ROLES[number]
export const ADMIN_PANEL_ROLES = ["admin", ...MANAGED_ROLES] as const
export type AdminPanelRole = typeof ADMIN_PANEL_ROLES[number]

export function isAdminPanelRole(value: unknown): value is AdminPanelRole {
  return typeof value === "string" && (ADMIN_PANEL_ROLES as readonly string[]).includes(value)
}

export interface ModulePermission {
  module: AdminModule
  canView: boolean
  canCreate: boolean
  canEdit: boolean
  canDelete: boolean
}

function isAdminModule(value: string): value is AdminModule {
  return (ADMIN_MODULES as readonly string[]).includes(value)
}

function mapRow(row: RowDataPacket | undefined, module: AdminModule): ModulePermission {
  return {
    module,
    canView: Boolean(row?.can_view),
    canCreate: Boolean(row?.can_create),
    canEdit: Boolean(row?.can_edit),
    canDelete: Boolean(row?.can_delete),
  }
}

/** Berilgan rol uchun barcha modullar bo'yicha huquqlar ro'yxati (bo'sh bo'lgan modullar ham 0/false bilan qaytadi). */
export async function getRolePermissions(role: string): Promise<ModulePermission[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM lms_role_permissions WHERE role = ?", [role])
  const byModule = new Map(rows.map((r) => [String(r.module), r]))
  return ADMIN_MODULES.map((mod) => mapRow(byModule.get(mod), mod))
}

/** Boshqaruv (Ruxsatlar) sahifasi uchun — admin va boshqariladigan barcha rollar, bitta so'rovda. */
export async function getManagedRolePermissions(): Promise<Record<AdminPanelRole, ModulePermission[]>> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM lms_role_permissions WHERE role IN (?)", [[...ADMIN_PANEL_ROLES]])
  const find = (role: string, mod: AdminModule) => rows.find((r) => String(r.role) === role && String(r.module) === mod)
  return Object.fromEntries(
    ADMIN_PANEL_ROLES.map((role) => [role, ADMIN_MODULES.map((mod) => mapRow(find(role, mod), mod))])
  ) as Record<AdminPanelRole, ModulePermission[]>
}

export async function setRolePermission(
  role: string,
  module: string,
  perm: { canView: boolean; canCreate: boolean; canEdit: boolean; canDelete: boolean }
): Promise<void> {
  if (!isAdminModule(module)) throw new Error("Noto'g'ri modul")
  await pool.query(
    `INSERT INTO lms_role_permissions (role, module, can_view, can_create, can_edit, can_delete)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       can_view = VALUES(can_view), can_create = VALUES(can_create),
       can_edit = VALUES(can_edit), can_delete = VALUES(can_delete)`,
    [role, module, perm.canView ? 1 : 0, perm.canCreate ? 1 : 0, perm.canEdit ? 1 : 0, perm.canDelete ? 1 : 0]
  )
}

/** Berilgan rol uchun bitta modulda ma'lum amalga ruxsat bor-yo'qligini tekshiradi.
    'admin' roli har doim to'liq huquqli (jadval qatori bo'lmasa ham) — bu FIXED
    admin uchun emas (u alohida tekshiriladi), balki DB-granted 'admin' roli uchun. */
export async function hasPermission(role: string | null, module: AdminModule, action: PermissionAction): Promise<boolean> {
  if (!role) return false
  if (role === "admin") return true
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT can_view, can_create, can_edit, can_delete FROM lms_role_permissions WHERE role = ? AND module = ?",
    [role, module]
  )
  const r = rows[0]
  if (!r) return false
  if (action === "view") return Boolean(r.can_view)
  if (action === "create") return Boolean(r.can_create)
  if (action === "edit") return Boolean(r.can_edit)
  return Boolean(r.can_delete)
}
