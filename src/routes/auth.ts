import { Router, Request, Response } from "express"
import bcrypt from "bcryptjs"
import jwt from "jsonwebtoken"
import { users } from "../db/data"

const router = Router()

// POST /api/auth/login
router.post("/login", (req: Request, res: Response): void => {
  const { username, password } = req.body
  if (!username || !password) {
    res.status(400).json({ success: false, message: "Username va parol kiritilishi shart" })
    return
  }

  const user = users.find((u) => u.username === username)
  if (!user) {
    res.status(401).json({ success: false, message: "Foydalanuvchi topilmadi" })
    return
  }

  const valid = bcrypt.compareSync(password, user.password)
  if (!valid) {
    res.status(401).json({ success: false, message: "Parol noto'g'ri" })
    return
  }

  if (user.status === "inactive") {
    res.status(403).json({ success: false, message: "Hisobingiz faol emas" })
    return
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "7d" }
  )

  const { password: _, ...safeUser } = user
  res.json({ success: true, token, user: safeUser })
})

// GET /api/auth/me
router.get("/me", (req: Request, res: Response): void => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, message: "Token topilmadi" })
    return
  }
  try {
    const decoded = jwt.verify(
      authHeader.split(" ")[1],
      process.env.JWT_SECRET || "secret"
    ) as { id?: string; username?: string; fullName?: string; role?: string; hemisToken?: string; isEmployee?: boolean }

    // HEMIS foydalanuvchisi — JWT ichida hemisToken mavjud
    if (decoded.hemisToken) {
      res.json({
        success: true,
        user: {
          id: decoded.username || "hemis_user",
          fullName: decoded.fullName || decoded.username || "HEMIS Foydalanuvchi",
          username: decoded.username || "",
          phone: "",
          role: decoded.role || "student",
          status: "active",
          createdAt: new Date().toISOString(),
        },
      })
      return
    }

    // Admin foydalanuvchisi
    const user = users.find((u) => u.id === decoded.id)
    if (!user) { res.status(404).json({ success: false, message: "Topilmadi" }); return }
    const { password: _, ...safeUser } = user
    res.json({ success: true, user: safeUser })
  } catch {
    res.status(401).json({ success: false, message: "Token yaroqsiz" })
  }
})

export default router
