/* Test muhiti: har bir test fayli birinchi bo'lib shuni import qiladi.
   - fayllar vaqtinchalik papkaga yoziladi (haqiqiy storage'ga tegilmaydi);
   - JWT siri tasodifiy, .env o'qilmaydi;
   - baza so'rovlari stub — haqiqiy MySQL'ga ulanish yo'q. */
import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { after } from "node:test"

export const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), "lms-sec-test-"))
process.env.LOCAL_RESOURCE_STORAGE = STORAGE
process.env.JWT_SECRET = `test-${crypto.randomBytes(16).toString("hex")}`

// db moduli muhit o'rnatilgandan keyin yuklanadi; pool'ning ichki taymeri
// jarayonni ushlab turmasin
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require("../src/services/db") as typeof import("../src/services/db")
after(async () => {
  await pool.end()
  fs.rmSync(STORAGE, { recursive: true, force: true })
})
