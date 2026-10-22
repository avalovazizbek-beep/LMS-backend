import { STORAGE } from "./setup"
import http from "http"
import type { AddressInfo } from "net"
import express from "express"
import jwt from "jsonwebtoken"
import { pool } from "../src/services/db"

export { STORAGE }

type Rows = Record<string, unknown>[]
type Handler = (sql: string, params: unknown[]) => Rows | undefined

/** pool.query o'rniga: handler qator qaytarsa — natija, undefined bo'lsa —
    kutilmagan so'rov (test xato bilan tugaydi, jim o'tib ketmaydi). */
export function stubDb(handler: Handler) {
  const fake = async (sql: unknown, params: unknown[] = []) => {
    const text = String(sql)
    const rows = handler(text, params)
    if (rows === undefined) throw new Error(`Testda kutilmagan SQL: ${text.replace(/\s+/g, " ").slice(0, 120)}`)
    return [rows, []]
  }
  ;(pool as unknown as { query: unknown }).query = fake
}

export function token(payload: Record<string, unknown>): string {
  return jwt.sign(payload, process.env.JWT_SECRET as string, { expiresIn: "5m" })
}

export async function startApp(mount: (app: express.Express) => void) {
  const app = express()
  app.use(express.json({ limit: "25mb" }))
  mount(app)
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** URL'ni o'zgartirmasdan yuboradi (fetch "../" ni o'zi normallashtirib yubormasin) */
export function rawGet(base: string, rawPath: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: rawPath, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

export const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex"
)
