import { Router, Response } from "express"
import { authMiddleware, AuthRequest } from "../middleware/auth"
import { markAttendanceSynced, resolveMeetingUser } from "../services/meetingStore"

const router = Router()
router.use(authMiddleware)

router.post("/attendance/sync", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = await resolveMeetingUser(req.user)
  if (user.role === "student") {
    res.status(403).json({ success: false, message: "Sync uchun ruxsat yo'q" })
    return
  }

  const queued = await markAttendanceSynced()
  res.json({ success: true, data: { queued } })
})

export default router
