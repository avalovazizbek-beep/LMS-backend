import { Router, Response } from "express"
import { v4 as uuid } from "uuid"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { pool } from "../services/db"
import type mysql from "mysql2/promise"

const router = Router()
router.use(authMiddleware)

const THRESHOLD = 0.62

function euclidean(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0))
}
function bestDist(candidate: number[], stored: number[][]): number {
  return Math.min(...stored.map(d => euclidean(candidate, d)))
}

/* ── GET /api/face/status ─────────────────────────────────────────── */
router.get("/status", async (req: AuthRequest, res: Response) => {
  const un = req.user?.username
  if (!un) { res.status(401).json({ success: false }); return }

  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT registered_at FROM face_registrations WHERE username = ? LIMIT 1", [un]
    )
    if (!rows.length) { res.json({ success: true, registered: false }); return }

    const [pendingRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM face_requests WHERE username = ? AND status = 'pending' LIMIT 1", [un]
    )
    const [approvedRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM face_requests WHERE username = ? AND status = 'approved' LIMIT 1", [un]
    )

    res.json({
      success:            true,
      registered:         true,
      confirmed:          true,
      registeredAt:       new Date(rows[0].registered_at).getTime(),
      hasPendingRequest:  pendingRows.length > 0,
      hasApprovedRequest: approvedRows.length > 0,
    })
  } catch (err) {
    res.status(500).json({ success: false, message: "DB xatolik" })
  }
})

/* ── POST /api/face/register ──────────────────────────────────────── */
router.post("/register", async (req: AuthRequest, res: Response) => {
  const un          = req.user?.username
  const displayName = req.user?.username
  if (!un) { res.status(401).json({ success: false }); return }

  const { descriptors } = req.body as { descriptors: number[][] }
  if (!Array.isArray(descriptors) || descriptors.length < 1) {
    res.status(400).json({ success: false, message: "Kamida 1 ta yuz tasviri kerak" }); return
  }

  try {
    const [existing] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM face_registrations WHERE username = ? LIMIT 1", [un]
    )

    if (existing.length) {
      const [approvedRows] = await pool.query<mysql.RowDataPacket[]>(
        "SELECT id FROM face_requests WHERE username = ? AND status = 'approved' LIMIT 1", [un]
      )
      if (!approvedRows.length) {
        res.status(409).json({
          success: false,
          message: "Yuz allaqachon ro'yxatdan o'tgan. Qayta ro'yxatdan o'tish uchun avval ariza yuboring.",
          alreadyRegistered: true,
        }); return
      }
      // Consume the approval
      await pool.query(
        "UPDATE face_requests SET status = 'rejected', admin_note = ? WHERE username = ? AND status = 'approved'",
        ["(qayta ro'yxatdan o'tish tugallandi)", un]
      )
    }

    await pool.query(
      `INSERT INTO face_registrations (username, display_name, descriptors)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), descriptors = VALUES(descriptors), registered_at = CURRENT_TIMESTAMP`,
      [un, displayName, JSON.stringify(descriptors)]
    )

    res.json({ success: true, message: "Yuz muvaffaqiyatli ro'yxatdan o'tdi" })
  } catch (err) {
    res.status(500).json({ success: false, message: "DB xatolik" })
  }
})

/* ── POST /api/face/verify ────────────────────────────────────────── */
router.post("/verify", async (req: AuthRequest, res: Response) => {
  const un = req.user?.username
  if (!un) { res.status(401).json({ success: false }); return }

  const { descriptor } = req.body as { descriptor: number[] }
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    res.status(400).json({ success: false, message: "Descriptor noto'g'ri" }); return
  }

  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT descriptors FROM face_registrations WHERE username = ? LIMIT 1", [un]
    )
    if (!rows.length) {
      res.json({ success: true, verified: false, reason: "not_registered",
        message: "Yuz ro'yxatdan o'tkazilmagan. Imtihon oldidan ro'yxatdan o'ting." })
      return
    }

    const stored: number[][] = JSON.parse(rows[0].descriptors)
    const dist     = bestDist(descriptor, stored)
    const verified = dist <= THRESHOLD
    const confidence = Math.max(0, Math.min(1, 1 - dist / THRESHOLD))
    res.json({ success: true, verified, confidence, distance: dist })
  } catch (err) {
    res.status(500).json({ success: false, message: "DB xatolik" })
  }
})

/* ── POST /api/face/re-register-request ──────────────────────────── */
router.post("/re-register-request", async (req: AuthRequest, res: Response) => {
  const un = req.user?.username
  if (!un) { res.status(401).json({ success: false }); return }

  try {
    const [existing] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT id FROM face_requests WHERE username = ? AND status = 'pending' LIMIT 1", [un]
    )
    if (existing.length) {
      res.status(409).json({ success: false, message: "Sizda allaqachon ko'rib chiqilayotgan ariza mavjud" }); return
    }

    const { reason } = req.body as { reason?: string }
    await pool.query(
      "INSERT INTO face_requests (id, username, reason, status, admin_note, created_at) VALUES (?, ?, ?, 'pending', '', ?)",
      [uuid(), un, reason?.trim() || "Ko'rsatilmagan", Date.now()]
    )
    res.json({ success: true, message: "Ariza muvaffaqiyatli yuborildi" })
  } catch (err) {
    res.status(500).json({ success: false, message: "DB xatolik" })
  }
})

/* ── GET /api/face/requests ───────────────────────────────────────── */
router.get("/requests", async (_req: AuthRequest, res: Response) => {
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT * FROM face_requests ORDER BY created_at DESC"
    )
    res.json({ success: true, data: rows })
  } catch (err) {
    res.status(500).json({ success: false, message: "DB xatolik" })
  }
})

/* ── PUT /api/face/requests/:id ───────────────────────────────────── */
router.put("/requests/:id", async (req: AuthRequest, res: Response) => {
  const { id } = req.params
  const { action, adminNote } = req.body as { action: "approve" | "reject"; adminNote?: string }

  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT username FROM face_requests WHERE id = ? LIMIT 1", [id]
    )
    if (!rows.length) { res.status(404).json({ success: false, message: "Ariza topilmadi" }); return }

    const username = rows[0].username
    const newStatus = action === "approve" ? "approved" : "rejected"

    await pool.query(
      "UPDATE face_requests SET status = ?, admin_note = ?, reviewed_at = ? WHERE id = ?",
      [newStatus, adminNote?.trim() ?? "", Date.now(), id]
    )

    // Tasdiqlanganda yuz ma'lumotlarini o'chiramiz — foydalanuvchi qayta ro'yxatdan o'tsin
    if (action === "approve") {
      await pool.query("DELETE FROM face_registrations WHERE username = ?", [username])
    }

    res.json({ success: true, message: action === "approve" ? "Ariza tasdiqlandi" : "Ariza rad etildi" })
  } catch (err) {
    res.status(500).json({ success: false, message: "DB xatolik" })
  }
})

export default router
