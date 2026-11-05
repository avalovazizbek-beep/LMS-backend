/**
 * Meeting yuklama sinovi (load test) — server tomoni.
 *
 * Soxta (HEMIS'da yo'q) o'qituvchi va talabalar bilan sinov xonalari ochadi.
 * Botlar (loadtest/ papkasi, boshqa kompyuterda) shu tokenlar bilan oddiy
 * talaba kabi kiradi: /api/meetings/:id/join-token → socket.io → mediasoup.
 *
 *   1) Xonalar + tokenlar (avval faqat ko'rsatadi, --apply bilan yaratadi):
 *        npx ts-node -P scripts/tsconfig.json scripts/meeting-yuklama.ts --setup --rooms 3 --students 120 --apply
 *      Tokenlar /tmp/yuklama-tokens.json ga yoziladi (8 soat amal qiladi).
 *   2) Sinov davomida server holati (har 5 s bir qator, oxirida xulosa):
 *        npx ts-node -P scripts/tsconfig.json scripts/meeting-yuklama.ts --monitor --seconds 1800
 *   3) Sinov tugagach — hammasini o'chirish:
 *        npx ts-node -P scripts/tsconfig.json scripts/meeting-yuklama.ts --cleanup --apply
 *
 * Xavfsizlik:
 * - ID'lar HEMIS'da uchramaydigan diapazonda (sinov-guruh.ts bilan bir
 *   qatorda): guruhlar 990000200+k, o'qituvchilar 990200000+k, talabalar
 *   990100000 + k*1000 + i. Real talaba/guruh bilan to'qnashmaydi.
 * - Meeting to'g'ridan-to'g'ri DB'ga yoziladi: bildirishnoma ketmaydi, fan
 *   biriktirilmaydi (yakunlanganda resursga tushmaydi). API orqali "end"
 *   QILINMAYDI — asosiy davomatga (lms_attendance) hech narsa o'tmaydi;
 *   --cleanup qatorlarni to'g'ridan-to'g'ri o'chiradi.
 * - Botlar HEMIS'ga hech qanday so'rov yubormaydi (faqat meeting API).
 */
import "dotenv/config"
import fs from "fs"
import os from "os"
import jwt from "jsonwebtoken"
import type mysql from "mysql2/promise"
import { pool, toMysqlDate } from "../src/services/db"

const GROUP_BASE = 990000200
const TEACHER_BASE = 990200000
const STUDENT_BASE = 990100000
const ID_MIN = 990100000   // foydalanuvchilar: talabalar 9901xxxxx, o'qituvchilar 9902xxxxx (990000201 = sinov talaba — tegilmaydi)
const ID_MAX = 990299999
const TITLE_PREFIX = "YUKLAMA SINOVI"
const TOKENS_FILE = "/tmp/yuklama-tokens.json"

const argv = process.argv
const has = (flag: string) => argv.includes(flag)
function arg(name: string): string | null {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null
}
const apply = has("--apply")

// Kirish tokeni auth middleware bilan bir xil kalit bilan imzolanadi
const ACCESS_SECRET = process.env.JWT_SECRET || "secret"

function pad(n: number, w: number) { return String(n).padStart(w, "0") }

async function liveNow(): Promise<{ meetings: number; people: number }> {
  const [m] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM lms_meetings WHERE status = 'live' AND title NOT LIKE ?`, [`${TITLE_PREFIX}%`]
  )
  const [p] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(DISTINCT a.user_id) AS n
       FROM lms_meeting_attendance_sessions s
       JOIN lms_meeting_attendance a ON a.id = s.attendance_id
       JOIN lms_meetings m ON m.id = a.meeting_id
      WHERE s.left_at IS NULL AND m.status = 'live' AND m.title NOT LIKE ?
        AND s.joined_at > NOW() - INTERVAL 4 HOUR`, [`${TITLE_PREFIX}%`]
  ).catch(() => [[{ n: -1 }]] as unknown as [mysql.RowDataPacket[]])
  return { meetings: Number(m[0]?.n ?? 0), people: Number(p[0]?.n ?? 0) }
}

async function testMeetingIds(): Promise<number[]> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id FROM lms_meetings WHERE title LIKE ? AND created_by_user_id BETWEEN ? AND ?`,
    [`${TITLE_PREFIX}%`, ID_MIN, ID_MAX]
  )
  return rows.map((r) => Number(r.id))
}

/* ── --setup ─────────────────────────────────────────────────────────── */
async function setup() {
  const rooms = Math.max(1, Math.min(30, Number(arg("--rooms") ?? 1)))
  const students = Math.max(1, Math.min(300, Number(arg("--students") ?? 120)))
  const hours = Math.max(1, Math.min(12, Number(arg("--hours") ?? 8)))

  const live = await liveNow()
  console.log(`Hozir jonli (haqiqiy) darslar: ${live.meetings} ta, ichida ~${live.people} kishi`)
  console.log(`Yaratiladi: ${rooms} xona × (1 o'qituvchi + ${students} talaba) = ${rooms * (students + 1)} soxta ishtirokchi`)

  const existing = await testMeetingIds()
  if (existing.length) {
    console.log(`Avvalgi sinov xonalari bor (${existing.join(", ")}) — avval --cleanup --apply qiling.`)
    return
  }
  if (!apply) {
    console.log("Faqat ko'rsatildi. Yaratish uchun --apply qo'shing.")
    return
  }

  const now = new Date()
  const end = new Date(now.getTime() + hours * 3600_000)
  const out = {
    createdAt: now.toISOString(),
    expiresAt: end.toISOString(),
    base: "https://lms.sies.uz",
    rooms: [] as Array<{
      meetingId: number; groupId: number
      teacher: { id: number; name: string; token: string }
      students: Array<{ id: number; name: string; token: string }>
    }>,
  }
  const sign = (payload: Record<string, unknown>) =>
    jwt.sign(payload, ACCESS_SECRET, { expiresIn: `${hours}h` })

  for (let k = 0; k < rooms; k++) {
    const groupId = GROUP_BASE + k
    const teacherId = TEACHER_BASE + k
    const teacherName = `Sinov O'qituvchi ${pad(k + 1, 2)}`
    const settings = { allowCamera: true, allowMicrophone: true, allowScreenShare: false, allowChat: true }
    const [res] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO lms_meetings (title, description, subject_name, created_by_user_id, start_time, end_time, status, settings_json, external_url, content_id)
       VALUES (?, ?, NULL, ?, ?, ?, 'live', ?, NULL, NULL)`,
      [`${TITLE_PREFIX} #${k + 1} — avtomatik o'chiriladi`, "Yuklama sinovi (soxta ishtirokchilar)", teacherId,
        toMysqlDate(now), toMysqlDate(end), JSON.stringify(settings)]
    )
    const meetingId = res.insertId
    await pool.query("INSERT INTO lms_meeting_groups (meeting_id, group_id) VALUES (?, ?)", [meetingId, groupId])

    const teacherToken = sign({
      id: teacherId, userId: teacherId, username: teacherName, fullName: teacherName,
      role: "teacher", groupId: null, teacherGroupIds: [groupId],
    })
    const list: Array<{ id: number; name: string; token: string }> = []
    for (let i = 1; i <= students; i++) {
      const id = STUDENT_BASE + k * 1000 + i
      const name = `Sinov Talaba ${pad(k + 1, 2)}-${pad(i, 3)}`
      list.push({ id, name, token: sign({ id, userId: id, username: name, fullName: name, role: "student", groupId }) })
    }
    out.rooms.push({ meetingId, groupId, teacher: { id: teacherId, name: teacherName, token: teacherToken }, students: list })
    console.log(`  xona #${k + 1}: meeting ${meetingId}, guruh ${groupId}, ${students} talaba`)
  }

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(out), { mode: 0o600 })
  console.log(`\nTokenlar: ${TOKENS_FILE} (${Math.round(fs.statSync(TOKENS_FILE).size / 1024)} KB, ${hours} soat amal qiladi)`)
}

/* ── --cleanup ───────────────────────────────────────────────────────── */
async function cleanup() {
  const ids = await testMeetingIds()
  const [[users]] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS n FROM lms_meeting_users WHERE id BETWEEN ? AND ?", [ID_MIN, ID_MAX]
  )
  console.log(`Sinov xonalari: ${ids.length ? ids.join(", ") : "yo'q"}; soxta foydalanuvchilar: ${users.n}`)
  if (!apply) {
    console.log("Faqat ko'rsatildi. O'chirish uchun --apply qo'shing.")
    return
  }
  if (ids.length) {
    // Avval 'ended' — ochiq socketlar yangi ulanish qila olmaydi
    await pool.query("UPDATE lms_meetings SET status = 'ended' WHERE id IN (?)", [ids])
    const [s] = await pool.query<mysql.ResultSetHeader>(
      `DELETE s FROM lms_meeting_attendance_sessions s
         JOIN lms_meeting_attendance a ON a.id = s.attendance_id WHERE a.meeting_id IN (?)`, [ids])
    const [a] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_meeting_attendance WHERE meeting_id IN (?)", [ids])
    await pool.query("DELETE FROM lms_meeting_groups WHERE meeting_id IN (?)", [ids])
    const [m] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_meetings WHERE id IN (?)", [ids])
    console.log(`  o'chirildi: ${m.affectedRows} meeting, ${a.affectedRows} davomat, ${s.affectedRows} sessiya`)
  }
  // Soxta foydalanuvchi qatorlari (boshqa joyda qolgan bo'lsa ham)
  const [a2] = await pool.query<mysql.ResultSetHeader>(
    `DELETE s FROM lms_meeting_attendance_sessions s
       JOIN lms_meeting_attendance a ON a.id = s.attendance_id WHERE a.user_id BETWEEN ? AND ?`, [ID_MIN, ID_MAX])
  const [a3] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_meeting_attendance WHERE user_id BETWEEN ? AND ?", [ID_MIN, ID_MAX])
  const [tg] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_teacher_groups WHERE user_id BETWEEN ? AND ?", [ID_MIN, ID_MAX])
  const [u] = await pool.query<mysql.ResultSetHeader>("DELETE FROM lms_meeting_users WHERE id BETWEEN ? AND ?", [ID_MIN, ID_MAX])
  console.log(`  o'chirildi: ${u.affectedRows} soxta foydalanuvchi, ${tg.affectedRows} o'qituvchi-guruh, ${a3.affectedRows + a2.affectedRows} qoldiq davomat`)
  if (fs.existsSync(TOKENS_FILE)) { fs.unlinkSync(TOKENS_FILE); console.log(`  ${TOKENS_FILE} o'chirildi`) }
}

/* ── --monitor ───────────────────────────────────────────────────────── */
const CLK_TCK = 100

function procCpuTicks(pid: string): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return Number(rest[11]) + Number(rest[12])   // utime + stime
  } catch { return null }
}

function findPids(): { workers: string[]; backend: string[] } {
  const workers: string[] = []
  const backend: string[] = []
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim()
      if (comm.startsWith("mediasoup-work")) { workers.push(pid); continue }
      if (comm === "node" || comm.startsWith("node ")) {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
        if (cmd.includes("dist/server.js") && !cmd.includes("meeting-yuklama")) backend.push(pid)
      }
    } catch { /* jarayon tugagan */ }
  }
  return { workers, backend }
}

function netBytes(): { rx: number; tx: number; iface: string } {
  const lines = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2)
  let best = { rx: 0, tx: 0, iface: "?" }
  for (const line of lines) {
    const [name, data] = line.split(":")
    if (!data) continue
    const iface = name.trim()
    if (iface === "lo") continue
    const f = data.trim().split(/\s+/).map(Number)
    if (f[0] + f[8] > best.rx + best.tx) best = { rx: f[0], tx: f[8], iface }
  }
  return best
}

function udpSockets(): number {
  let n = 0
  for (const f of ["/proc/net/udp", "/proc/net/udp6"]) {
    try { n += fs.readFileSync(f, "utf8").split("\n").length - 2 } catch { /* yo'q */ }
  }
  return n
}

async function testPeople(): Promise<number> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT COUNT(DISTINCT a.user_id) AS n FROM lms_meeting_attendance_sessions s
       JOIN lms_meeting_attendance a ON a.id = s.attendance_id
      WHERE s.left_at IS NULL AND a.user_id BETWEEN ? AND ?`, [ID_MIN, ID_MAX])
  return Number(rows[0]?.n ?? 0)
}

async function monitor() {
  const seconds = Math.max(10, Number(arg("--seconds") ?? 1800))
  const step = 5
  const cores = os.cpus().length
  let pids = findPids()
  console.log(`mediasoup-worker: ${pids.workers.length} ta, backend node: ${pids.backend.join(",") || "topilmadi"}, yadro: ${cores}`)
  console.log("vaqt     | sinov | jonli(real) | worker CPU jami / eng band | backend CPU | tarmoq chiqish / kirish | UDP | load")

  let prevTicks = new Map<string, number>()
  const readTicks = () => {
    const m = new Map<string, number>()
    for (const pid of [...pids.workers, ...pids.backend]) {
      const t = procCpuTicks(pid)
      if (t !== null) m.set(pid, t)
    }
    return m
  }
  prevTicks = readTicks()
  let prevNet = netBytes()
  let prevAt = Date.now()
  const samples: Array<{ people: number; wSum: number; wMax: number; be: number; txM: number; rxM: number }> = []

  const deadline = Date.now() + seconds * 1000
  let iter = 0
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step * 1000))
    if (++iter % 12 === 0) pids = findPids()   // PM2 qayta ishga tushirgan bo'lsa
    const ticks = readTicks()
    const net = netBytes()
    const dt = (Date.now() - prevAt) / 1000
    const pct = (pid: string) => {
      const a = prevTicks.get(pid), b = ticks.get(pid)
      return a == null || b == null ? 0 : ((b - a) / CLK_TCK / dt) * 100
    }
    const w = pids.workers.map(pct)
    const wSum = w.reduce((s, x) => s + x, 0)
    const wMax = w.length ? Math.max(...w) : 0
    const be = pids.backend.map(pct).reduce((s, x) => s + x, 0)
    const txM = ((net.tx - prevNet.tx) * 8) / dt / 1e6
    const rxM = ((net.rx - prevNet.rx) * 8) / dt / 1e6
    const people = await testPeople().catch(() => -1)
    const live = await liveNow().catch(() => ({ meetings: -1, people: -1 }))
    samples.push({ people, wSum, wMax, be, txM, rxM })
    const t = new Date().toTimeString().slice(0, 8)
    console.log(
      `${t} | ${String(people).padStart(5)} | ${String(live.meetings).padStart(3)} / ${String(live.people).padStart(4)}  | ` +
      `${wSum.toFixed(0).padStart(5)}% / ${wMax.toFixed(0).padStart(3)}%          | ${be.toFixed(0).padStart(5)}%      | ` +
      `${txM.toFixed(1).padStart(7)} / ${rxM.toFixed(1).padStart(6)} Mbit/s | ${String(udpSockets()).padStart(5)} | ${os.loadavg()[0].toFixed(1)}`
    )
    prevTicks = ticks
    prevNet = net
    prevAt = Date.now()
  }

  const peak = samples.reduce((m, s) => (s.people > m.people ? s : m), samples[0])
  const max = (f: (s: typeof samples[0]) => number) => Math.max(...samples.map(f))
  console.log("\n── Xulosa ──")
  console.log(`Eng ko'p sinov ishtirokchisi: ${peak?.people ?? 0}`)
  console.log(`Worker CPU (jami, ${cores} yadrodan 100% = 1 yadro): max ${max((s) => s.wSum).toFixed(0)}%, eng band worker max ${max((s) => s.wMax).toFixed(0)}%`)
  console.log(`Backend (node) CPU max: ${max((s) => s.be).toFixed(0)}%  (100% = 1 yadro — socket.io/API bitta yadroda)`)
  console.log(`Tarmoq chiqish max: ${max((s) => s.txM).toFixed(1)} Mbit/s, kirish max: ${max((s) => s.rxM).toFixed(1)} Mbit/s`)
}

async function main() {
  try {
    if (has("--setup")) await setup()
    else if (has("--cleanup")) await cleanup()
    else if (has("--monitor")) await monitor()
    else console.log("Rejim: --setup | --monitor | --cleanup  (fayl boshidagi izohga qarang)")
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
