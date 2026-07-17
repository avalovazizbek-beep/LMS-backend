import fs from "fs"
import os from "os"
import path from "path"
import { execFile } from "child_process"
import { randomUUID } from "crypto"
import jwt from "jsonwebtoken"
import express, { Router, Response } from "express"
import { authMiddleware, requireRole, AuthRequest, AuthUser } from "../middleware/auth"
import { pool } from "../services/db"
import { notifications } from "../db/data"
import { parseNumber } from "../services/meetingStore"
import { syncTeacherFromHemis, employeeTeachesGroup } from "./hemis"
import {
  type ContentType,
  type ContentFile,
  type TeacherContentRecord,
  type UpdateContentInput,
  contentStatus,
  teacherUserId,
  studentUserId,
  teachingUploadsDir,
  submissionUploadsDir,
  privateStorageRoot,
  questionImagesDir,
  sanitizeFilename,
  getTeacherGroupIds,
  getTeacherGroups,
  getGroupById,
  getTeacherSchedule,
  listTeacherContent,
  getTeacherContent,
  createTeacherContent,
  updateTeacherContent,
  deleteTeacherContent,
  addContentFile,
  getContentFile,
  removeContentFile,
  upsertSubmission,
  listSubmissions,
  getSubmissionForStudent,
  getSubmissionById,
  getProgressBulk,
  getSubmissionsBulk,
  getPeriodGrades,
  upsertPeriodGrade,
  gradeSubmission,
  getContentProgress,
  upsertContentProgress,
  type ContentProgress,
  type SubmissionRecord,
} from "../services/teachingStore"
import {
  listQuestions,
  replaceQuestions,
  countQuestions,
  submitExamAnswers,
  saveExamSession,
  getExamSession,
  deleteExamSession,
  buildOptionPerms,
} from "../services/examStore"
import {
  type AttendanceStatus,
  type AttendanceRecordInput,
  getGroupRoster,
  saveAttendance,
  getAttendanceForGroupDate,
  getGroupAttendanceHistory,
  getStudentAttendance,
  getGroupSessions,
  getStudentSessions,
  getAttendanceSummary,
} from "../services/attendanceStore"
import {
  type GradeRecordInput,
  saveGrade,
  getGradeForGroupDate,
  getGroupGradeHistory,
} from "../services/gradeStore"

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET || "secret"
const MAX_UPLOAD_BYTES = Number(process.env.LOCAL_RESOURCE_MAX_BYTES || 2 * 1024 * 1024 * 1024)
const ALLOWED_EXTENSIONS = new Set([
  ".mp4", ".webm", ".mov", ".mkv", ".avi",
  ".mp3", ".wav", ".m4a", ".ogg", ".aac",
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".txt", ".rtf",
  ".zip", ".rar", ".7z",
  ".jpg", ".jpeg", ".png", ".gif", ".webp",
])

/* ── kichik yordamchilar ──────────────────────────────────────────── */
function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const CONTENT_TYPES: ContentType[] = ["lesson", "assignment", "exam", "mavzu", "kurs-topshiriq", "kalendar", "malumot"]
const EXAM_PASS_RATIO = 0.6   // 60% — test o'tish chegarasi (keyingi mavzuni ochish uchun)

// Old submissions stored grade as 0-100 percentage; new ones are scaled to contentMaxScore.
// If grade > maxScore (and maxScore > 0 && maxScore < 100), it's old format — convert it.
function normalizeGrade(grade: number | null | undefined, maxScore: number | null | undefined): number {
  if (!grade) return 0
  const ms = maxScore ?? 0
  if (ms > 0 && ms < 100 && grade > ms) return Math.round((grade / 100) * ms)
  return grade
}

function safeContentType(value: string): ContentType | null {
  return (CONTENT_TYPES as string[]).includes(value) ? (value as ContentType) : null
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime())
}

function fullNameOf(user?: AuthUser) {
  return (
    textValue(user?.fullName) ||
    textValue(user?.username) ||
    textValue(user?.employeeProfile?.full_name) ||
    textValue(user?.employeeProfile?.name) ||
    "Foydalanuvchi"
  )
}

function studentGroupId(user?: AuthUser): number | null {
  return parseNumber(user?.groupId)
}

interface ContentMeta {
  type: ContentType | null
  groupId: number | null
  subjectName: string
  topicKey: string
  title: string
  description: string
  kind: string
  controlType: string
  resourceType: string
  meetingLink: string
  availableFrom: string
  deadline: string
  maxScore: number | null
  attemptsCount: number | null
  language: string
  completionPoints: number | null
  durationMinutes: number | null
  trainingLoad: number | null
  lessonDate: string
  delivered: boolean
}

function boolValue(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1
}

function readContentMeta(source: Record<string, unknown>): ContentMeta {
  return {
    type: safeContentType(textValue(source.type)),
    groupId: numberValue(source.groupId ?? source.group_id),
    subjectName: textValue(source.subjectName ?? source.subject_name),
    topicKey: textValue(source.topicKey ?? source.topic_key),
    title: textValue(source.title),
    description: textValue(source.description),
    kind: textValue(source.kind),
    controlType: textValue(source.controlType ?? source.control_type),
    resourceType: textValue(source.resourceType ?? source.resource_type),
    meetingLink: textValue(source.meetingLink ?? source.meeting_link),
    availableFrom: textValue(source.availableFrom ?? source.available_from),
    deadline: textValue(source.deadline),
    maxScore: numberValue(source.maxScore ?? source.max_score),
    attemptsCount: numberValue(source.attemptsCount ?? source.attempts_count),
    language: textValue(source.language),
    completionPoints: numberValue(source.completionPoints ?? source.completion_points),
    durationMinutes: numberValue(source.durationMinutes ?? source.duration_minutes),
    trainingLoad: numberValue(source.trainingLoad ?? source.training_load),
    lessonDate: textValue(source.lessonDate ?? source.lesson_date),
    delivered: boolValue(source.delivered),
  }
}

function presentForStudent(item: TeacherContentRecord): TeacherContentRecord {
  if (item.status !== "locked") return item
  // Dedline ochilmaguncha talaba kontent tafsilotini va faylini ko'ra olmaydi
  return { ...item, description: null, file: null }
}

/* ── token-tekshiruvchi fayl endpointlari (authMiddleware'dan OLDIN) ──
   Brauzer <a href>/<video src> orqali to'g'ridan-to'g'ri token (query)
   bilan ochilishi mumkin bo'lishi kerak — shu sababli umumiy
   authMiddleware ulanishidan oldin joylashtirilgan, hemis.ts:/download
   namunasiga o'xshab. */
function userFromRequest(req: AuthRequest): AuthUser | null {
  if (req.user) return req.user
  const headerToken = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.split(" ")[1]
    : null
  const queryToken = textValue(req.query.token)
  const token = headerToken || queryToken
  if (!token) return null
  try {
    return jwt.verify(token, JWT_SECRET) as AuthUser
  } catch {
    return null
  }
}

/** Xom oqim sifatida (multipart emas) yuborilgan faylni `storage/private/teaching` ga yozadi. */
function receiveUploadedFile(req: AuthRequest, res: Response): Promise<ContentFile | null> {
  return new Promise((resolve) => {
    const originalName = textValue(req.query.filename || req.headers["x-file-name"]) || "fayl"
    const ext = path.extname(originalName).toLowerCase()
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ success: false, message: "Bu turdagi fayl qabul qilinmaydi" })
      resolve(null)
      return
    }
    const contentLength = Number(req.headers["content-length"] || 0)
    if (contentLength > MAX_UPLOAD_BYTES) {
      res.status(413).json({ success: false, message: "Fayl hajmi ruxsat etilgan chegaradan katta" })
      resolve(null)
      return
    }

    const storedName = sanitizeFilename(originalName)
    const relativePath = `/teaching/${storedName}`
    const absolutePath = path.join(teachingUploadsDir(), storedName)
    const stream = fs.createWriteStream(absolutePath)
    let written = 0
    let done = false

    function fail(status: number, message: string) {
      if (done) return
      done = true
      req.unpipe(stream)
      stream.destroy()
      fs.rm(absolutePath, { force: true }, () => undefined)
      res.status(status).json({ success: false, message })
      resolve(null)
    }

    req.on("data", (chunk: Buffer) => {
      written += chunk.length
      if (written > MAX_UPLOAD_BYTES) fail(413, "Fayl hajmi ruxsat etilgan chegaradan katta")
    })
    req.on("error", () => fail(400, "Fayl yuklashda xatolik"))
    stream.on("error", () => fail(500, "Fayl saqlanmadi"))

    stream.on("finish", () => {
      if (done) return
      done = true
      resolve({
        name: storedName,
        originalName,
        mimeType: textValue(req.headers["content-type"]) || "application/octet-stream",
        size: written,
        relativePath,
        url: "",
      })
    })

    req.pipe(stream)
  })
}

function streamPrivateFile(res: Response, relativePath: string, originalName: string, mimeType: string) {
  const absolutePath = path.join(privateStorageRoot(), relativePath.replace(/^\/+/, ""))
  if (!fs.existsSync(absolutePath)) {
    res.status(404).json({ success: false, message: "Fayl topilmadi" })
    return
  }
  res.setHeader("Content-Type", mimeType || "application/octet-stream")
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(originalName)}"`)
  fs.createReadStream(absolutePath).pipe(res)
}

router.get("/content/:id/file", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = userFromRequest(req)
  if (!user) {
    res.status(401).json({ success: false, message: "Token topilmadi yoki yaroqsiz" })
    return
  }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || !content.file) {
    res.status(404).json({ success: false, message: "Fayl topilmadi" })
    return
  }

  if (user.role === "employee") {
    if (content.teacherUserId !== teacherUserId(user)) {
      res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
      return
    }
  } else {
    const groupId = studentGroupId(user)
    if (groupId === null || groupId !== content.groupId) {
      res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
      return
    }
    if (content.status === "locked") {
      res.status(403).json({ success: false, message: "Bu material hali ochilish vaqti kelmagan" })
      return
    }
  }

  streamPrivateFile(res, content.file.relativePath, content.file.originalName, content.file.mimeType)
})

const PPTX_EXTRACT_PY = `
import sys, zipfile, xml.etree.ElementTree as ET, json, re
NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PNS = 'http://schemas.openxmlformats.org/presentationml/2006/main'
def slide_texts(z, name):
    root = ET.fromstring(z.read(name))
    blocks = []
    for sp in root.iter('{' + PNS + '}sp'):
        paras = []
        for para in sp.iter('{' + NS + '}p'):
            runs = [el.text for el in para.iter('{' + NS + '}t') if el.text and el.text.strip()]
            if runs:
                paras.append(''.join(runs))
        if paras:
            blocks.append('\\n'.join(paras))
    return '\\n\\n'.join(blocks) if blocks else ''
try:
    with zipfile.ZipFile(sys.argv[1]) as z:
        names = sorted(
            n for n in z.namelist()
            if re.match(r'ppt/slides/slide[0-9]+\\.xml$', n)
        )
        print(json.dumps({'count': len(names), 'slides': [slide_texts(z, n) for n in names]}))
except Exception as e:
    print(json.dumps({'count': 0, 'slides': [], 'error': str(e)}))
`.trim()

/* Rich PPTX extractor — extracts slide bg color, text shapes with position/size/color/font */
const PPTX_RICH_PY = `
import sys, zipfile, json, re, colorsys
from xml.etree import ElementTree as ET

NS  = 'http://schemas.openxmlformats.org/drawingml/2006/main'
PNS = 'http://schemas.openxmlformats.org/presentationml/2006/main'

DEFAULT_THEME = {
    'dk1':'#000000','lt1':'#ffffff','dk2':'#44546a','lt2':'#e7e6e6',
    'accent1':'#4472c4','accent2':'#ed7d31','accent3':'#a9d18e',
    'accent4':'#ffc000','accent5':'#5b9bd5','accent6':'#70ad47',
    'hlink':'#0563c1','folHlink':'#954f72',
}

def si(v, d=0):
    try: return int(v)
    except: return d

def load_theme(z):
    colors = dict(DEFAULT_THEME)
    try:
        xml = ET.fromstring(z.read('ppt/theme/theme1.xml'))
        cs = xml.find('.//{'+NS+'}clrScheme')
        if cs is not None:
            for child in cs:
                tag = child.tag.split('}')[-1]
                for cc in child:
                    t2 = cc.tag.split('}')[-1]
                    if t2 == 'srgbClr': colors[tag] = '#'+cc.get('val','000000').zfill(6)
                    elif t2 == 'sysClr': colors[tag] = '#'+cc.get('lastClr','000000').zfill(6)
    except: pass
    return colors

def apply_lum(hex_clr, mod=None, off=None):
    r,g,b = int(hex_clr[1:3],16)/255, int(hex_clr[3:5],16)/255, int(hex_clr[5:7],16)/255
    h,l,s = colorsys.rgb_to_hls(r,g,b)
    if mod: l *= si(mod.get('val',100000))/100000
    if off: l += si(off.get('val',0))/100000
    r,g,b = colorsys.hls_to_rgb(h,max(0,min(1,l)),s)
    return '#{:02x}{:02x}{:02x}'.format(int(r*255),int(g*255),int(b*255))

def parse_clr(el, theme):
    if el is None: return None
    sc = el.find('{'+NS+'}srgbClr')
    if sc is not None: return '#'+sc.get('val','000000').zfill(6)
    sy = el.find('{'+NS+'}sysClr')
    if sy is not None: return '#'+sy.get('lastClr','000000').zfill(6)
    sch = el.find('{'+NS+'}schemeClr')
    if sch is not None:
        base = (theme or DEFAULT_THEME).get(sch.get('val',''), DEFAULT_THEME.get(sch.get('val','')))
        if base:
            mod = sch.find('{'+NS+'}lumMod')
            off = sch.find('{'+NS+'}lumOff')
            if mod or off: return apply_lum(base, mod, off)
            return base
    return None

def first_fill_clr(root_el, theme):
    sf = root_el.find('.//{'+NS+'}solidFill')
    c = parse_clr(sf, theme)
    if c: return c
    # gradient — average first and last stop for a representative colour
    gf = root_el.find('.//{'+NS+'}gradFill')
    if gf is not None:
        stops = gf.findall('.//{'+NS+'}gs')
        if stops:
            c = parse_clr(stops[0], theme)
            if c: return c
    return None

def slide_size(z):
    try:
        prs = ET.fromstring(z.read('ppt/presentation.xml'))
        sz = prs.find('{'+PNS+'}sldSz')
        if sz is not None: return si(sz.get('cx'),9144000), si(sz.get('cy'),5143500)
    except: pass
    return 9144000, 5143500

def resolve_rel_path(base, target):
    parts = (base.rsplit('/',1)[0]+'/'+target).split('/')
    out = []
    for p in parts:
        if p == '..': out and out.pop()
        elif p and p != '.': out.append(p)
    return '/'.join(out)

def bg_from_tree(tree, ns_p, theme):
    cSld = tree.find('{'+ns_p+'}cSld')
    if cSld is None: return None
    bg_el = cSld.find('{'+ns_p+'}bg')
    if bg_el is None: return None
    # bgRef means "use master bg" — skip
    if bg_el.find('.//{'+NS+'}bgRef') is not None: return None
    return first_fill_clr(bg_el, theme)

def get_slide_bg(z, slide_name, slide_tree, theme):
    # 1. Slide's own bg
    c = bg_from_tree(slide_tree, PNS, theme)
    if c: return c
    # 2. Layout bg
    try:
        rel_path = slide_name.replace('ppt/slides/slide','ppt/slides/_rels/slide').replace('.xml','.xml.rels')
        for rel in ET.fromstring(z.read(rel_path)):
            if 'slideLayout' in rel.get('Type',''):
                layout_path = resolve_rel_path(slide_name, rel.get('Target',''))
                try:
                    lt = ET.fromstring(z.read(layout_path))
                    c = bg_from_tree(lt, PNS, theme)
                    if c: return c
                    # 3. Master bg via layout's rels
                    lrel_path = layout_path.replace('ppt/slideLayouts/slideLayout','ppt/slideLayouts/_rels/slideLayout').replace('.xml','.xml.rels')
                    for lrel in ET.fromstring(z.read(lrel_path)):
                        if 'slideMaster' in lrel.get('Type',''):
                            master_path = resolve_rel_path(layout_path, lrel.get('Target',''))
                            try:
                                mt = ET.fromstring(z.read(master_path))
                                c = bg_from_tree(mt, PNS, theme)
                                if c: return c
                            except: pass
                except: pass
    except: pass
    return '#ffffff'

def parse_slide(z, name, sw, sh, theme):
    tree = ET.fromstring(z.read(name))
    bg = get_slide_bg(z, name, tree, theme)
    shapes = []
    for sp in tree.iter('{'+PNS+'}sp'):
        xfrm = sp.find('.//{'+NS+'}xfrm')
        if xfrm is None: continue
        off = xfrm.find('{'+NS+'}off')
        ext = xfrm.find('{'+NS+'}ext')
        if off is None or ext is None: continue
        x,y,w,h = si(off.get('x')),si(off.get('y')),si(ext.get('cx')),si(ext.get('cy'))
        fill = first_fill_clr(sp, theme)
        paras = []
        for para in sp.iter('{'+NS+'}p'):
            pPr = para.find('{'+NS+'}pPr')
            amap = {'c':'center','r':'right','just':'justify','dist':'justify'}
            algn = amap.get(pPr.get('algn','l') if pPr is not None else 'l','left')
            spc = None
            if pPr is not None:
                lsEl = pPr.find('.//{'+NS+'}spcPct')
                if lsEl is not None: spc = si(lsEl.get('val',100000))//1000
            runs = []
            for ch in para:
                tag = ch.tag.split('}')[-1]
                if tag == 'r':
                    rPr = ch.find('{'+NS+'}rPr')
                    txt = ''.join(t.text or '' for t in ch.iter('{'+NS+'}t'))
                    if not txt: continue
                    sz = si(rPr.get('sz',1800) if rPr is not None else 1800)//100
                    b = rPr is not None and rPr.get('b') in ('1','true')
                    i = rPr is not None and rPr.get('i') in ('1','true')
                    clr = None
                    if rPr is not None:
                        sf = rPr.find('{'+NS+'}solidFill')
                        if sf is not None: clr = parse_clr(sf, theme)
                    runs.append({'t':txt,'b':b,'i':i,'sz':max(sz,8),'c':clr})
                elif tag == 'br':
                    runs.append({'t':'\\n','b':False,'i':False,'sz':14,'c':None})
            if any(r['t'].strip() for r in runs):
                paras.append({'r':runs,'a':algn,'ls':spc})
        if paras:
            shapes.append({
                'x':round(x/sw*100,3),'y':round(y/sh*100,3),
                'w':round(w/sw*100,3),'h':round(h/sh*100,3),
                'fill':fill,'p':paras
            })
    return {'bg':bg,'shapes':shapes}

try:
    with zipfile.ZipFile(sys.argv[1]) as z:
        sw, sh = slide_size(z)
        theme = load_theme(z)
        names = sorted(n for n in z.namelist() if re.match(r'ppt/slides/slide[0-9]+\\.xml$',n))
        slides = [parse_slide(z,n,sw,sh,theme) for n in names]
        print(json.dumps({'count':len(slides),'slides':slides,'sw':sw,'sh':sh}))
except Exception as e:
    print(json.dumps({'count':0,'slides':[],'error':str(e)}))
`.trim()

router.get("/content/:id/pptx-slides", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = userFromRequest(req)
  if (!user) { res.status(401).json({ success: false }); return }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || !content.file) { res.json({ count: 0, slides: [] }); return }

  if (user.role !== "employee") {
    const groupId = studentGroupId(user)
    if (groupId === null || groupId !== content.groupId || content.status === "locked") {
      res.status(403).json({ success: false }); return
    }
  }

  const absPath = path.join(privateStorageRoot(), content.file.relativePath.replace(/^\/+/, ""))
  if (!fs.existsSync(absPath)) { res.json({ count: 0, slides: [] }); return }

  execFile("python", ["-c", PPTX_EXTRACT_PY, absPath], { timeout: 12000 }, (err, stdout) => {
    try {
      res.json(JSON.parse(stdout || "{}"))
    } catch {
      res.json({ count: 0, slides: [] })
    }
  })
})

/* ── GET /content/:id/pptx-rich-slides — rich slide data with colors/positioning ── */
router.get("/content/:id/pptx-rich-slides", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = userFromRequest(req)
  if (!user) { res.status(401).json({ success: false }); return }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || !content.file) { res.json({ count: 0, slides: [] }); return }

  if (user.role !== "employee") {
    const groupId = studentGroupId(user)
    if (groupId === null || groupId !== content.groupId || content.status === "locked") {
      res.status(403).json({ success: false }); return
    }
  }

  const absPath = path.join(privateStorageRoot(), content.file.relativePath.replace(/^\/+/, ""))
  if (!fs.existsSync(absPath)) { res.json({ count: 0, slides: [] }); return }

  execFile("python", ["-c", PPTX_RICH_PY, absPath], { timeout: 20000 }, (err, stdout) => {
    try {
      res.json(JSON.parse(stdout || "{}"))
    } catch {
      res.json({ count: 0, slides: [] })
    }
  })
})

/* ── GET /content/:id/pptx-as-pdf — PPTX → PDF conversion (LibreOffice) ── */
router.get("/content/:id/pptx-as-pdf", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = userFromRequest(req)
  if (!user) { res.status(401).end(); return }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || !content.file) { res.status(404).end(); return }

  if (user.role !== "employee") {
    const groupId = studentGroupId(user)
    if (!groupId || groupId !== content.groupId || content.status === "locked") {
      res.status(403).end(); return
    }
  }

  const absPath = path.join(privateStorageRoot(), content.file.relativePath.replace(/^\/+/, ""))
  if (!fs.existsSync(absPath)) { res.status(404).end(); return }

  const cacheDir = path.join(os.tmpdir(), "lms-pptx-pdf")
  fs.mkdirSync(cacheDir, { recursive: true })
  const pdfPath = path.join(cacheDir, `pptx_${content.id}.pdf`)

  const serve = () => {
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader("Content-Disposition", `inline; filename="presentation_${content.id}.pdf"`)
    fs.createReadStream(pdfPath).pipe(res)
  }

  if (fs.existsSync(pdfPath)) { serve(); return }

  // Try LibreOffice (Windows: soffice.exe, Linux/Mac: libreoffice or soffice)
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "soffice"]
    : ["libreoffice", "soffice"]

  let tried = 0
  function tryNext() {
    if (tried >= candidates.length) { res.status(422).end(); return }
    const bin = candidates[tried++]
    execFile(bin, ["--headless", "--convert-to", "pdf", "--outdir", cacheDir, absPath], { timeout: 45000 }, (err) => {
      if (err) { tryNext(); return }
      // LibreOffice names output after input basename
      const auto = path.join(cacheDir, path.basename(absPath, path.extname(absPath)) + ".pdf")
      if (!fs.existsSync(auto)) { tryNext(); return }
      try { fs.renameSync(auto, pdfPath) } catch { /* already renamed */ }
      serve()
    })
  }
  tryNext()
})

router.get("/content/:id/files/:fileId", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = userFromRequest(req)
  if (!user) {
    res.status(401).json({ success: false, message: "Token topilmadi yoki yaroqsiz" })
    return
  }
  const id = numberValue(req.params.id)
  const fileId = numberValue(req.params.fileId)
  const content = id !== null ? await getTeacherContent(id) : null
  const file = content && fileId !== null ? await getContentFile(id!, fileId) : null
  if (!content || !file) {
    res.status(404).json({ success: false, message: "Fayl topilmadi" })
    return
  }

  if (user.role === "employee") {
    if (content.teacherUserId !== teacherUserId(user)) {
      res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
      return
    }
  } else {
    const groupId = studentGroupId(user)
    if (groupId === null || groupId !== content.groupId) {
      res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
      return
    }
    if (content.status === "locked") {
      res.status(403).json({ success: false, message: "Bu material hali ochilish vaqti kelmagan" })
      return
    }
  }

  streamPrivateFile(res, file.relativePath, file.originalName, file.mimeType)
})

router.get("/submissions/:id/file", async (req: AuthRequest, res: Response): Promise<void> => {
  const user = userFromRequest(req)
  if (!user) {
    res.status(401).json({ success: false, message: "Token topilmadi yoki yaroqsiz" })
    return
  }
  const id = numberValue(req.params.id)
  const submission = id !== null ? await getSubmissionById(id) : null
  if (!submission || !submission.file) {
    res.status(404).json({ success: false, message: "Fayl topilmadi" })
    return
  }
  const content = await getTeacherContent(submission.contentId)
  const isOwnerTeacher = user.role === "employee" && content && content.teacherUserId === teacherUserId(user)
  const isOwnerStudent = user.role !== "employee" && submission.studentUserId === studentUserId(user)
  if (!isOwnerTeacher && !isOwnerStudent) {
    res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
    return
  }

  streamPrivateFile(res, submission.file.relativePath, submission.file.originalName, submission.file.mimeType)
})

/* ── keyingi barcha yo'nalishlar JWT talab qiladi ─────────────────── */
router.use(authMiddleware)

/* ── GET /groups — biriktirilgan guruhlar ─────────────────────────── */
router.get("/groups", async (req: AuthRequest, res: Response) => {
  if (req.user?.role === "employee") {
    const groups = await getTeacherGroups(teacherUserId(req.user))
    res.json({ success: true, data: groups })
    return
  }

  const groupId = studentGroupId(req.user)
  const group = groupId !== null ? await getGroupById(groupId) : null
  res.json({ success: true, data: group ? [group] : [] })
})

/* ── POST /sync — HEMIS'dan guruh va jadvalni qayta sinxronlash ────── */
router.post("/sync", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi sinxronlay oladi" })
    return
  }
  const token = req.headers.authorization?.split(" ")[1]
  if (!token) {
    res.status(401).json({ success: false, message: "Token topilmadi" })
    return
  }
  await syncTeacherFromHemis(token)
  const [groups, schedule] = await Promise.all([
    getTeacherGroups(teacherUserId(req.user)),
    getTeacherSchedule(teacherUserId(req.user)),
  ])
  res.json({ success: true, message: "HEMIS bilan sinxronlandi", data: { groups, schedule } })
})

/* ── GET /schedule — o'qituvchining saqlangan dars jadvali ─────────── */
router.get("/schedule", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const schedule = await getTeacherSchedule(teacherUserId(req.user))
  res.json({ success: true, data: schedule })
})

/* ── GET /my-subjects — o'qituvchining fanlari (content dan) ────────── */
router.get("/my-subjects", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" }); return
  }
  const tId = teacherUserId(req.user)
  const groupId = numberValue(req.query.groupId)
  const params: unknown[] = [tId]
  let where = "teacher_user_id = ? AND is_active = 1 AND group_id IS NOT NULL"
  if (groupId !== null) { where += " AND group_id = ?"; params.push(groupId) }

  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT DISTINCT group_id, subject_name FROM lms_teacher_content WHERE ${where} ORDER BY subject_name`,
    params
  )
  res.json({
    success: true,
    data: rows.map(r => ({
      groupId: Number(r.group_id),
      subjectName: String(r.subject_name),
    })),
  })
})

/* ── GET /content — ro'yxat (lesson/assignment/exam) ───────────────── */
router.get("/content", async (req: AuthRequest, res: Response): Promise<void> => {
  const type = safeContentType(textValue(req.query.type)) ?? undefined
  const subjectName = textValue(req.query.subject) || undefined

  if (req.user?.role === "employee") {
    const tId = teacherUserId(req.user)
    const groupId = numberValue(req.query.group) ?? undefined
    const items = await listTeacherContent({ type, teacherUserId: tId, groupId, subjectName })
    res.json({ success: true, data: items })
    return
  }

  const groupId = studentGroupId(req.user)
  if (groupId === null) {
    res.json({ success: true, data: [] })
    return
  }
  const items = await listTeacherContent({ type, groupId, subjectName })
  res.json({ success: true, data: items.map(presentForStudent) })
})

/* ── GET /content/by-topic — bitta mavzuga tegishli barcha qismlar ─── */
router.get("/content/by-topic", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const topicKey = textValue(req.query.topicKey)
  if (!topicKey) {
    res.status(400).json({ success: false, message: "topicKey majburiy" })
    return
  }
  const groupId = numberValue(req.query.groupId) ?? undefined
  const tId = teacherUserId(req.user)
  const items = await listTeacherContent({ teacherUserId: tId, groupId, topicKey })
  res.json({ success: true, data: items })
})

/* ── GET /content/topics — talaba uchun mavzular (ketma-ket qulflash) ── */
router.get("/content/topics", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const subjectName = textValue(req.query.subject)
  if (!subjectName) {
    res.status(400).json({ success: false, message: "subject majburiy" })
    return
  }
  const groupId = studentGroupId(req.user)
  if (groupId === null) {
    res.json({ success: true, data: [] })
    return
  }
  const sId = studentUserId(req.user)
  const items = await listTeacherContent({ groupId, subjectName })

  const topicMap = new Map<string, TeacherContentRecord[]>()
  const order: string[] = []
  for (const item of items) {
    if (!item.topicKey) continue
    if (!topicMap.has(item.topicKey)) {
      topicMap.set(item.topicKey, [])
      order.push(item.topicKey)
    }
    topicMap.get(item.topicKey)!.push(item)
  }
  order.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const topics: Array<{
    topicKey: string
    title: string
    locked: boolean
    completed: boolean
    sections: {
      video: (TeacherContentRecord & { progress: ContentProgress | null; sectionLocked: boolean }) | null
      audio: (TeacherContentRecord & { progress: ContentProgress | null; sectionLocked: boolean }) | null
      theory: (TeacherContentRecord & { progress: ContentProgress | null; sectionLocked: boolean }) | null
      qollanma: (TeacherContentRecord & { progress: ContentProgress | null; sectionLocked: boolean }) | null
      test: (TeacherContentRecord & { submission: SubmissionRecord | null; maxScore: number; sectionLocked: boolean }) | null
      assignment: (TeacherContentRecord & { submission: SubmissionRecord | null; sectionLocked: boolean }) | null
      /** Qo'shimcha YouTube video — ixtiyoriy, ketma-ket qulflash zanjiriga kirmaydi */
      youtube: (TeacherContentRecord & { sectionLocked: boolean }) | null
    }
  }> = []

  let previousCompleted = true
  for (const topicKey of order) {
    const group = topicMap.get(topicKey)!
    const marker = group.find((i) => i.type === "mavzu" && i.kind === "topic")
    const video = group.find((i) => i.type === "mavzu" && i.kind === "video_lesson") ?? null
    const audio = group.find((i) => i.type === "mavzu" && i.kind === "audio") ?? null
    const theory = group.find((i) => i.type === "mavzu" && i.kind === "theory") ?? null
    const qollanma = group.find((i) => i.type === "mavzu" && i.kind === "qollanma") ?? null
    const test = group.find((i) => i.type === "exam") ?? null
    const assignment = group.find((i) => i.type === "assignment") ?? null
    const youtube = group.find((i) => i.type === "mavzu" && i.kind === "youtube") ?? null

    const title = marker?.title ?? group[0].title

    const videoProgress    = video    ? await getContentProgress(video.id, sId)    : null
    const audioProgress    = audio    ? await getContentProgress(audio.id, sId)    : null
    const theoryProgress   = theory   ? await getContentProgress(theory.id, sId)   : null
    const qollanmaProgress = qollanma ? await getContentProgress(qollanma.id, sId) : null

    let testSubmission: SubmissionRecord | null = null
    let testCompleted = true
    let maxScore = 0
    if (test) {
      testSubmission = await getSubmissionForStudent(test.id, sId)
      const qCount = await countQuestions(test.id)
      maxScore = qCount > 0 ? 100 : 0
      if (maxScore === 0) {
        testCompleted = testSubmission !== null
      } else {
        testCompleted = !!(testSubmission && testSubmission.grade != null && testSubmission.grade >= maxScore * EXAM_PASS_RATIO)
      }
    }

    let assignmentSubmission: SubmissionRecord | null = null
    let assignmentCompleted = true
    if (assignment) {
      assignmentSubmission = await getSubmissionForStudent(assignment.id, sId)
      assignmentCompleted = assignmentSubmission != null
    }

    // Barcha mavjud sectionlar ketma-ket zanjir hosil qiladi:
    // video tugamasdan audio ochilmaydi, audio tugamasdan taqdimot ochilmaydi va h.k.
    const orderedSections = [
      { key: "video",      item: video,      done: !!videoProgress?.completed },
      { key: "audio",      item: audio,      done: !!audioProgress?.completed },
      { key: "theory",     item: theory,     done: !!theoryProgress?.completed },
      { key: "qollanma",   item: qollanma,   done: !!qollanmaProgress?.completed },
      { key: "test",       item: test,       done: testCompleted },
      { key: "assignment", item: assignment, done: assignmentCompleted },
    ]
    const sequence = orderedSections.filter(s => s.item !== null)

    function computeSectionLocked(key: string): boolean {
      const idx = sequence.findIndex(s => s.key === key)
      if (idx <= 0) return false
      return !sequence.slice(0, idx).every(s => s.done)
    }

    const videoSection    = video    ? { ...presentForStudent(video),    progress: videoProgress,    sectionLocked: computeSectionLocked("video") }    : null
    const audioSection    = audio    ? { ...presentForStudent(audio),    progress: audioProgress,    sectionLocked: computeSectionLocked("audio") }    : null
    const theorySection   = theory   ? { ...presentForStudent(theory),   progress: theoryProgress,   sectionLocked: computeSectionLocked("theory") }   : null
    const qollanmaSection = qollanma ? { ...presentForStudent(qollanma), progress: qollanmaProgress, sectionLocked: computeSectionLocked("qollanma") } : null
    const testSection     = test     ? { ...presentForStudent(test),     submission: testSubmission, maxScore, sectionLocked: computeSectionLocked("test") }             : null
    const assignmentSection = assignment ? { ...presentForStudent(assignment), submission: assignmentSubmission, sectionLocked: computeSectionLocked("assignment") }    : null
    // Youtube — ixtiyoriy bonus material, hech qachon qulflanmaydi (ketma-ket zanjirga kirmaydi)
    const youtubeSection = youtube ? { ...presentForStudent(youtube), sectionLocked: false } : null

    const completed =
      (!videoSection    || !!videoSection.progress?.completed) &&
      (!audioSection    || !!audioSection.progress?.completed) &&
      (!theorySection   || !!theorySection.progress?.completed) &&
      (!qollanmaSection || !!qollanmaSection.progress?.completed) &&
      testCompleted &&
      assignmentCompleted

    topics.push({
      topicKey,
      title,
      locked: !previousCompleted,
      completed,
      sections: { video: videoSection, audio: audioSection, theory: theorySection, qollanma: qollanmaSection, test: testSection, assignment: assignmentSection, youtube: youtubeSection },
    })

    previousCompleted = completed
  }

  res.json({ success: true, data: topics })
})

/* ── GET /my-topic-scores — talabaning mavzu bo'yicha ballari ──────── */
router.get("/my-topic-scores", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const subjectName = textValue(req.query.subject)
  if (!subjectName) {
    res.status(400).json({ success: false, message: "subject majburiy" })
    return
  }
  const groupId = studentGroupId(req.user)
  if (groupId === null) {
    res.json({ success: true, data: { topics: [] } })
    return
  }
  const sId = studentUserId(req.user)
  const items = await listTeacherContent({ groupId, subjectName })

  const topicMap = new Map<string, TeacherContentRecord[]>()
  for (const item of items) {
    if (!item.topicKey) continue
    if (!topicMap.has(item.topicKey)) topicMap.set(item.topicKey, [])
    topicMap.get(item.topicKey)!.push(item)
  }
  const topicKeys = Array.from(topicMap.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const contentIds = items.filter(c => c.topicKey).map(c => c.id)
  const [progressList, submissionList, periodGradeList] = await Promise.all([
    getProgressBulk(contentIds, [sId]),
    getSubmissionsBulk(contentIds, [sId]),
    getPeriodGrades(groupId, subjectName),
  ])

  const progressMap = new Map<number, boolean>()
  for (const p of progressList) progressMap.set(p.contentId, p.completed)
  const subMap = new Map<number, number | null>()
  for (const s of submissionList) subMap.set(s.contentId, s.grade)
  const periodMap = new Map<string, number | null>()
  for (const g of periodGradeList) periodMap.set(`${g.studentUserId}:${g.gradeType}`, g.grade)

  const topicsOut = topicKeys.map((key, i) => {
    const group = topicMap.get(key)!
    const mavzuItem = group.find(c => c.type === "mavzu" && c.kind === "topic") ?? group[0]
    const maxScore = group.reduce((s, c) => {
      if (c.type === "exam" || c.type === "assignment") return s + (c.maxScore ?? 0)
      return s
    }, 0)
    let earned = 0; let hasActivity = false
    for (const c of group) {
      if (c.type === "exam" || c.type === "assignment") {
        const g = subMap.get(c.id)
        if (g !== undefined) { earned += normalizeGrade(g, c.maxScore); hasActivity = true }
      }
    }
    return { key, idx: i + 1, title: mavzuItem?.title ?? key, maxScore, score: hasActivity ? earned : null }
  })

  const on1 = periodMap.get(`${sId}:ON1`) ?? null
  const on2 = periodMap.get(`${sId}:ON2`) ?? null
  const yn  = periodMap.get(`${sId}:YN`)  ?? null

  res.json({ success: true, data: { topics: topicsOut, on1, on2, yn } })
})

/* ── GET /content/:id/progress — talabaning ko'rish progresi ──────── */
router.get("/content/:id/progress", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const id = numberValue(req.params.id)
  if (id === null) {
    res.status(400).json({ success: false, message: "Noto'g'ri id" })
    return
  }
  const sId = studentUserId(req.user)
  const progress = await getContentProgress(id, sId)
  res.json({
    success: true,
    data: progress ?? {
      contentId: id,
      studentUserId: sId,
      maxPositionSeconds: 0,
      durationSeconds: null,
      pagesRead: [],
      totalPages: null,
      completed: false,
      completedAt: null,
    },
  })
})

/* ── PUT /content/:id/progress — talabaning ko'rish progresini yangilash ── */
router.put("/content/:id/progress", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const id = numberValue(req.params.id)
  if (id === null) {
    res.status(400).json({ success: false, message: "Noto'g'ri id" })
    return
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const positionSeconds = numberValue(body.positionSeconds) ?? undefined
  const durationSeconds = numberValue(body.durationSeconds) ?? undefined
  const totalPages = numberValue(body.totalPages) ?? undefined
  const pagesRead = Array.isArray(body.pagesRead)
    ? body.pagesRead.map((v) => Number(v)).filter((n) => Number.isFinite(n))
    : undefined
  const forceCompleted = body.completed === true ? true : undefined

  const progress = await upsertContentProgress({
    contentId: id,
    studentUserId: studentUserId(req.user),
    positionSeconds,
    durationSeconds,
    pagesRead,
    totalPages,
    forceCompleted,
  })
  res.json({ success: true, data: progress })
})

/* ── GET /content/:id — bitta element ──────────────────────────────── */
router.get("/content/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }

  if (req.user?.role === "employee") {
    if (content.teacherUserId !== teacherUserId(req.user)) {
      res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
      return
    }
    res.json({ success: true, data: content })
    return
  }

  const groupId = studentGroupId(req.user)
  if (groupId === null || groupId !== content.groupId) {
    res.status(403).json({ success: false, message: "Sizga ruxsat yo'q" })
    return
  }
  res.json({ success: true, data: presentForStudent(content) })
})

/* ── POST /content — yangi darslik/topshiriq/imtihon yaratish ──────── */
router.post("/content", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi kontent yarata oladi" })
    return
  }

  const isJson = (req.headers["content-type"] || "").toString().toLowerCase().includes("application/json")
  const source: Record<string, unknown> = isJson
    ? (req.body && typeof req.body === "object" ? req.body : {})
    : (req.query as Record<string, unknown>)
  const meta = readContentMeta(source)

  if (!meta.type) {
    res.status(400).json({ success: false, message: `type maydoni quyidagilardan biri bo'lishi kerak: ${CONTENT_TYPES.join(", ")}` })
    return
  }
  if (meta.groupId === null) {
    res.status(400).json({ success: false, message: "groupId majburiy" })
    return
  }
  if (!meta.subjectName) {
    res.status(400).json({ success: false, message: "subjectName majburiy" })
    return
  }
  if (!meta.title) {
    res.status(400).json({ success: false, message: "title majburiy" })
    return
  }
  if (!meta.availableFrom || !isValidDate(meta.availableFrom)) {
    res.status(400).json({ success: false, message: "availableFrom (ochilish vaqti) majburiy va to'g'ri sana bo'lishi kerak" })
    return
  }
  if (meta.deadline && !isValidDate(meta.deadline)) {
    res.status(400).json({ success: false, message: "deadline noto'g'ri sana formatida" })
    return
  }

  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(meta.groupId)) {
    const allowed = meta.type === "kurs-topshiriq" && (await employeeTeachesGroup(meta.groupId, req.user))
    if (!allowed) {
      res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
      return
    }
  }

  const baseInput = {
    type: meta.type,
    teacherUserId: tId,
    groupId: meta.groupId,
    subjectName: meta.subjectName,
    topicKey: meta.topicKey || null,
    title: meta.title,
    description: meta.description || null,
    kind: meta.kind || null,
    controlType: meta.controlType || null,
    resourceType: meta.resourceType || null,
    meetingLink: meta.meetingLink || null,
    availableFrom: meta.availableFrom,
    deadline: meta.deadline || null,
    maxScore: meta.maxScore,
    attemptsCount: meta.attemptsCount,
    language: meta.language || null,
    completionPoints: meta.completionPoints,
    durationMinutes: meta.durationMinutes,
    trainingLoad: meta.trainingLoad,
    lessonDate: meta.lessonDate || null,
    delivered: meta.delivered,
  }

  if (isJson) {
    const record = await createTeacherContent({ ...baseInput, file: null })
    res.status(201).json({ success: true, data: record })
    return
  }

  // Xom oqim sifatida fayl yuborilmoqda (Content-Type: application/json emas)
  const file = await receiveUploadedFile(req, res)
  if (!file) return
  const record = await createTeacherContent({ ...baseInput, file })
  res.status(201).json({ success: true, data: record })
})

/* ── POST /content/:id/files — qo'shimcha fayl biriktirish (bir nechta) ── */
router.post("/content/:id/files", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi fayl biriktira oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || content.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const file = await receiveUploadedFile(req, res)
  if (!file) return
  const files = await addContentFile(id!, file)
  res.status(201).json({ success: true, data: files })
})

/* ── DELETE /content/:id/files/:fileId — biriktirilgan faylni o'chirish ── */
router.delete("/content/:id/files/:fileId", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi o'chira oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const fileId = numberValue(req.params.fileId)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || content.teacherUserId !== teacherUserId(req.user) || fileId === null) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const removed = await removeContentFile(id!, fileId)
  if (!removed) {
    res.status(404).json({ success: false, message: "Fayl topilmadi" })
    return
  }
  res.json({ success: true, message: "O'chirildi" })
})

/* ── PUT /content/:id — tahrirlash ─────────────────────────────────── */
router.put("/content/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi tahrirlay oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const existing = id !== null ? await getTeacherContent(id) : null
  if (!existing || existing.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const patch: UpdateContentInput = {}

  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title
  if ("description" in body) patch.description = textValue(body.description) || null
  if (typeof body.subjectName === "string" && body.subjectName.trim()) patch.subjectName = body.subjectName
  if ("kind" in body) patch.kind = textValue(body.kind) || null
  if ("controlType" in body) patch.controlType = textValue(body.controlType) || null
  if ("attemptsCount" in body) patch.attemptsCount = numberValue(body.attemptsCount)
  if ("questionDisplayCount" in body) patch.questionDisplayCount = numberValue(body.questionDisplayCount)
  if ("language" in body) patch.language = textValue(body.language) || null

  if (typeof body.availableFrom === "string" && body.availableFrom.trim()) {
    if (!isValidDate(body.availableFrom)) {
      res.status(400).json({ success: false, message: "availableFrom noto'g'ri sana formatida" })
      return
    }
    patch.availableFrom = body.availableFrom
  }
  if ("deadline" in body) {
    const deadline = textValue(body.deadline)
    if (deadline && !isValidDate(deadline)) {
      res.status(400).json({ success: false, message: "deadline noto'g'ri sana formatida" })
      return
    }
    patch.deadline = deadline || null
  }
  if ("maxScore" in body) patch.maxScore = numberValue(body.maxScore)
  if ("completionPoints" in body) patch.completionPoints = numberValue(body.completionPoints)
  if ("durationMinutes" in body) patch.durationMinutes = numberValue(body.durationMinutes)
  if ("trainingLoad" in body) patch.trainingLoad = numberValue(body.trainingLoad)
  if ("lessonDate" in body) patch.lessonDate = textValue(body.lessonDate) || null
  if ("delivered" in body) patch.delivered = boolValue(body.delivered)
  if ("isActive" in body) patch.isActive = boolValue(body.isActive)

  const updated = await updateTeacherContent(id!, patch)
  res.json({ success: true, data: updated })
})

/* ── PATCH /content/:id/toggle — "Faol" holatini almashtirish ──────── */
router.patch("/content/:id/toggle", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi o'zgartira oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const existing = id !== null ? await getTeacherContent(id) : null
  if (!existing || existing.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const updated = await updateTeacherContent(id!, { isActive: !existing.isActive })
  res.json({ success: true, data: updated })
})

/* ── DELETE /content/:id ───────────────────────────────────────────── */
router.delete("/content/:id", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi o'chira oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const existing = id !== null ? await getTeacherContent(id) : null
  if (!existing || existing.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  await deleteTeacherContent(id!)
  res.json({ success: true, message: "O'chirildi" })
})

/* ── POST /content/:id/submit — talaba topshiradi ──────────────────── */
router.post("/content/:id/submit", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba topshira oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  if (content.type === "lesson") {
    res.status(400).json({ success: false, message: "Darslikka topshiriq yuborib bo'lmaydi" })
    return
  }

  const groupId = studentGroupId(req.user)
  if (groupId === null || groupId !== content.groupId) {
    res.status(403).json({ success: false, message: "Bu sizning guruhingiz uchun emas" })
    return
  }

  const status = contentStatus(new Date(), content.availableFrom, content.deadline)
  if (status === "locked") {
    res.status(403).json({ success: false, message: "Bu topshiriq hali ochilmagan" })
    return
  }
  if (status === "closed") {
    res.status(403).json({ success: false, message: "Topshirish vaqti tugagan — endi hech narsa yuborib bo'lmaydi" })
    return
  }

  const sId = studentUserId(req.user)
  const isJson = (req.headers["content-type"] || "").toString().toLowerCase().includes("application/json")

  if (isJson) {
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
    const submission = await upsertSubmission({
      contentId: content.id,
      studentUserId: sId,
      studentFullName: fullNameOf(req.user),
      groupId,
      comment: textValue(body.comment) || null,
      file: null,
    })
    res.status(201).json({ success: true, data: submission })
    return
  }

  // Xom fayl oqimi
  const originalName = textValue(req.query.filename || req.headers["x-file-name"]) || "fayl"
  const ext = path.extname(originalName).toLowerCase()
  if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
    res.status(400).json({ success: false, message: "Bu turdagi fayl qabul qilinmaydi" })
    return
  }
  const contentLength = Number(req.headers["content-length"] || 0)
  if (contentLength > MAX_UPLOAD_BYTES) {
    res.status(413).json({ success: false, message: "Fayl hajmi ruxsat etilgan chegaradan katta" })
    return
  }

  const storedName = sanitizeFilename(originalName)
  const relativePath = `/submissions/${storedName}`
  const absolutePath = path.join(submissionUploadsDir(), storedName)
  const stream = fs.createWriteStream(absolutePath)
  let written = 0
  let done = false

  function fail(status: number, message: string) {
    if (done) return
    done = true
    req.unpipe(stream)
    stream.destroy()
    fs.rm(absolutePath, { force: true }, () => undefined)
    res.status(status).json({ success: false, message })
  }

  req.on("data", (chunk: Buffer) => {
    written += chunk.length
    if (written > MAX_UPLOAD_BYTES) fail(413, "Fayl hajmi ruxsat etilgan chegaradan katta")
  })
  req.on("error", () => fail(400, "Fayl yuklashda xatolik"))
  stream.on("error", () => fail(500, "Fayl saqlanmadi"))

  stream.on("finish", async () => {
    if (done) return
    done = true

    // Yozish tugagach holatni yana tekshiramiz — yozish davomida dedline o'tib ketgan bo'lishi mumkin
    const recheck = contentStatus(new Date(), content.availableFrom, content.deadline)
    if (recheck === "closed") {
      fs.rm(absolutePath, { force: true }, () => undefined)
      res.status(403).json({ success: false, message: "Topshirish vaqti tugagan — endi hech narsa yuborib bo'lmaydi" })
      return
    }

    const file: ContentFile = {
      name: storedName,
      originalName,
      mimeType: textValue(req.headers["content-type"]) || "application/octet-stream",
      size: written,
      relativePath,
      url: "",
    }
    const submission = await upsertSubmission({
      contentId: content.id,
      studentUserId: sId,
      studentFullName: fullNameOf(req.user),
      groupId,
      comment: textValue(req.query.comment) || null,
      file,
    })
    res.status(201).json({ success: true, data: submission })
  })

  req.pipe(stream)
})

/* ── GET /content/:id/submissions/me — talabaning o'z natijasi ─────── */
router.get("/content/:id/submissions/me", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const id = numberValue(req.params.id)
  if (id === null) {
    res.status(400).json({ success: false, message: "Noto'g'ri so'rov" })
    return
  }
  const submission = await getSubmissionForStudent(id, studentUserId(req.user))
  res.json({ success: true, data: submission })
})

/* ── GET /content/:id/submissions — o'qituvchi uchun ro'yxat ───────── */
router.get("/content/:id/submissions", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi ko'ra oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || content.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const submissions = await listSubmissions(content.id)
  res.json({ success: true, data: submissions })
})

/* ── PUT /submissions/:id/grade — baholash ─────────────────────────── */
router.put("/submissions/:id/grade", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi baholay oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const submission = id !== null ? await getSubmissionById(id) : null
  if (!submission) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const content = await getTeacherContent(submission.contentId)
  if (!content || content.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const grade = numberValue(body.grade)
  if (grade === null || grade < 0) {
    res.status(400).json({ success: false, message: "grade (baho) majburiy va musbat son bo'lishi kerak" })
    return
  }
  if (content.maxScore !== null && grade > content.maxScore) {
    res.status(400).json({ success: false, message: `Baho ${content.maxScore} balldan oshmasligi kerak` })
    return
  }

  const updated = await gradeSubmission(submission.id, teacherUserId(req.user), grade, textValue(body.feedback) || null)
  res.json({ success: true, data: updated })
})

/* ── Savol rasmlari ─────────────────────────────────────────────────── */

/* POST /question-image — o'qituvchi rasm yuklaydi, URL qaytariladi */
router.post(
  "/question-image",
  express.raw({ type: ["image/*", "application/octet-stream"], limit: "20mb" }),
  authMiddleware,
  requireRole("employee"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const originalName = textValue(req.query.filename || req.headers["x-file-name"]) || "image.jpg"
    const ext = path.extname(originalName).toLowerCase()
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      res.status(400).json({ success: false, message: "Bu turdagi fayl qabul qilinmaydi" })
      return
    }
    const body = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ success: false, message: "Fayl bo'sh yoki noto'g'ri format" })
      return
    }
    const storedName = sanitizeFilename(originalName)
    // Savol rasmlari public papkasiga saqlanadi — auth shart emas, <img> to'g'ridan-to'g'ri o'qiydi
    const absolutePath = path.join(questionImagesDir(), storedName)
    try {
      await fs.promises.writeFile(absolutePath, body)
      res.json({ success: true, data: { url: `/api/teaching/question-image/${storedName}` } })
    } catch {
      res.status(500).json({ success: false, message: "Fayl saqlanmadi" })
    }
  }
)

/* GET /question-image/:filename — rasm faylini xizmat qilish (auth talab qilinmaydi — <img> uchun) */
router.get("/question-image/:filename", async (req: AuthRequest, res: Response): Promise<void> => {
  const filename = req.params.filename
  if (!filename || filename.includes("..") || filename.includes("/")) {
    res.status(400).end()
    return
  }
  // Yangi papka (question-images) da qidiradi, topilmasa eski papkadan (private/teaching) qaraydi
  let absolutePath = path.join(questionImagesDir(), filename)
  if (!fs.existsSync(absolutePath)) {
    absolutePath = path.join(teachingUploadsDir(), filename)
  }
  if (!fs.existsSync(absolutePath)) {
    res.status(404).end()
    return
  }
  const mimeType = /\.(png)$/i.test(filename) ? "image/png"
    : /\.(jpg|jpeg)$/i.test(filename) ? "image/jpeg"
    : /\.(gif)$/i.test(filename) ? "image/gif"
    : /\.(webp)$/i.test(filename) ? "image/webp"
    : "image/jpeg"
  res.setHeader("Content-Type", mimeType)
  res.setHeader("Cache-Control", "public, max-age=86400")
  fs.createReadStream(absolutePath).pipe(res)
})

/* ── Imtihon savollari (MCQ) ─────────────────────────────────────────── */

/* GET /content/:id/questions — o'qituvchi: to'liq (correctIndex bilan),
   talaba: faqat status="open" bo'lsa, correctIndex'siz */
router.get("/content/:id/questions", async (req: AuthRequest, res: Response): Promise<void> => {
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }

  if (req.user?.role === "employee") {
    if (content.teacherUserId !== teacherUserId(req.user)) {
      res.status(404).json({ success: false, message: "Topilmadi" })
      return
    }
    const questions = await listQuestions(content.id)
    res.json({ success: true, data: questions })
    return
  }

  if (content.type !== "exam" || content.groupId !== studentGroupId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const status = contentStatus(new Date(), content.availableFrom, content.deadline)
  if (status !== "open") {
    res.status(403).json({ success: false, message: "Imtihon hozircha ochiq emas" })
    return
  }
  const sIdForSession = studentUserId(req.user)

  // Oldingi urinishni va limitni tekshirish
  const prevSubmission = await getSubmissionForStudent(content.id, sIdForSession)
  const maxAttempts = content.attemptsCount && content.attemptsCount > 0 ? content.attemptsCount : null
  const attemptsLeft = maxAttempts === null
    ? true
    : (prevSubmission ? prevSubmission.attemptsUsed < maxAttempts : true)

  if (prevSubmission && !attemptsLeft) {
    res.status(403).json({ success: false, message: `Urinishlar soni tugadi (${maxAttempts} ta)` })
    return
  }

  // Agar avvalgi sessiya mavjud bo'lsa va topshirilmagan (talaba savollarni ko'rgan lekin topshirmagan) —
  // o'sha sessiyani qaytaramiz. Aks holda yangi random sessiya yaratamiz.
  const existingSession = await getExamSession(content.id, sIdForSession)

  let questions = await listQuestions(content.id)
  let shownIds: number[]
  let optionPerms: Record<number, number[]>

  if (existingSession) {
    // Mavjud sessiya (topshirmagan, savollar allaqachon ko'rsatilgan)
    const byId = new Map(questions.map(q => [q.id, q]))
    questions = existingSession.questionIds.map(id => byId.get(id)).filter(Boolean) as typeof questions
    shownIds = existingSession.questionIds
    optionPerms = existingSession.optionPerms
    // questionDisplayCount o'zgartirilgan bo'lsa ham cheklov qo'llamiz
    const displayCount = content.questionDisplayCount
    if (displayCount && displayCount > 0 && displayCount < questions.length) {
      questions = questions.slice(0, displayCount)
      shownIds = questions.map(q => q.id)
    }
  } else {
    // Yangi sessiya: aralashtir va kerak bo'lsa kesib ol
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]]
    }
    const displayCount = content.questionDisplayCount
    if (displayCount && displayCount > 0 && displayCount < questions.length) {
      questions = questions.slice(0, displayCount)
    }
    shownIds = questions.map(q => q.id)
    optionPerms = buildOptionPerms(questions)
    await saveExamSession(content.id, sIdForSession, shownIds, optionPerms)
  }

  const publicQuestions = questions.map((q) => ({
    id: q.id,
    questionText: q.questionText,
    imageUrl: q.imageUrl ?? null,
    optionImages: q.optionImages ?? null,
    options: q.options,
    optionPerm: optionPerms[q.id] ?? q.options.map((_, i) => i),
    points: q.points,
  }))
  res.json({ success: true, data: publicQuestions })
})

/* PUT /content/:id/questions — o'qituvchi savollarni almashtiradi (bulk) */
router.put("/content/:id/questions", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi savollarni boshqara oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || content.teacherUserId !== teacherUserId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  if (content.type !== "exam") {
    res.status(400).json({ success: false, message: "Savollar faqat imtihon uchun belgilanadi" })
    return
  }

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const rawQuestions = Array.isArray(body.questions) ? body.questions : null
  if (!rawQuestions) {
    res.status(400).json({ success: false, message: "questions massivi majburiy" })
    return
  }

  const questions: { questionText: string; imageUrl?: string | null; optionImages?: (string | null)[] | null; options: string[]; correctIndex: number; correctIndexes: number[]; points: number }[] = []
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== "object") {
      res.status(400).json({ success: false, message: "Noto'g'ri savol formati" })
      return
    }
    const r = raw as Record<string, unknown>
    const questionText = textValue(r.questionText)
    const imageUrl = textValue(r.imageUrl) ?? null
    const optionImages: (string | null)[] | null = Array.isArray(r.optionImages)
      ? r.optionImages.map((v: unknown) => (typeof v === "string" && v ? v : null))
      : null
    const options = Array.isArray(r.options) ? r.options.map((o) => textValue(o)) : []
    const correctIndex = numberValue(r.correctIndex)
    const correctIndexesRaw = Array.isArray(r.correctIndexes)
      ? (r.correctIndexes as unknown[]).map((x) => numberValue(x)).filter((n): n is number => n !== null)
      : null
    const points = numberValue(r.points) ?? 1

    if (!questionText) {
      res.status(400).json({ success: false, message: "Savol matni bo'sh bo'lishi mumkin emas" })
      return
    }
    if (options.length < 2 || options.some((o) => !o)) {
      res.status(400).json({ success: false, message: "Har bir savolda kamida 2 ta variant bo'lishi kerak" })
      return
    }

    const finalIndexes = correctIndexesRaw?.length
      ? correctIndexesRaw
      : correctIndex !== null ? [correctIndex] : null

    if (!finalIndexes?.length || finalIndexes.some((i) => i < 0 || i >= options.length)) {
      res.status(400).json({ success: false, message: "To'g'ri javob indeksi noto'g'ri" })
      return
    }
    if (points < 1) {
      res.status(400).json({ success: false, message: "Ball kamida 1 bo'lishi kerak" })
      return
    }
    questions.push({ questionText, imageUrl, optionImages, options, correctIndex: finalIndexes[0], correctIndexes: finalIndexes, points })
  }

  const saved = await replaceQuestions(content.id, questions)
  res.json({ success: true, data: saved })
})

/* POST /content/:id/exam-submit — talaba javoblarni yuboradi, server avtomatik baholaydi */
router.post("/content/:id/exam-submit", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba topshira oladi" })
    return
  }
  const id = numberValue(req.params.id)
  const content = id !== null ? await getTeacherContent(id) : null
  if (!content || content.type !== "exam" || content.groupId !== studentGroupId(req.user)) {
    res.status(404).json({ success: false, message: "Topilmadi" })
    return
  }
  const status = contentStatus(new Date(), content.availableFrom, content.deadline)
  if (status !== "open") {
    res.status(403).json({ success: false, message: "Imtihon hozircha ochiq emas yoki muddati tugagan" })
    return
  }

  const sId = studentUserId(req.user)
  const existing = await getSubmissionForStudent(content.id, sId)

  // Agar talaba allaqachon o'tish balini olgan bo'lsa — qayta urinishga yo'l qo'ymaslik
  if (existing && existing.grade !== null) {
    const passThreshold = (content.maxScore !== null && content.maxScore > 0)
      ? content.maxScore * EXAM_PASS_RATIO
      : 60
    if (existing.grade >= passThreshold) {
      res.status(409).json({ success: false, message: "Siz bu testni allaqachon muvaffaqiyatli topshirdingiz" })
      return
    }
  }

  // Urinishlar limitini tekshirish (0 yoki null = cheksiz)
  const maxAttempts = content.attemptsCount && content.attemptsCount > 0 ? content.attemptsCount : null
  if (existing && maxAttempts !== null && existing.attemptsUsed >= maxAttempts) {
    res.status(409).json({
      success: false,
      message: `Siz bu imtihonga ${maxAttempts} marta urinib bo'ldingiz`,
    })
    return
  }

  const questionCount = await countQuestions(content.id)
  if (questionCount === 0) {
    res.status(400).json({ success: false, message: "Bu imtihon uchun savollar mavjud emas" })
    return
  }

  // Talabaga ko'rsatilgan savollar sessiyasi
  const session = await getExamSession(content.id, sId)
  const sessionIds = session?.questionIds ?? null
  const rawCount = sessionIds ? sessionIds.length : questionCount
  const displayCount = content.questionDisplayCount
  const expectedCount = (displayCount && displayCount > 0 && displayCount < rawCount) ? displayCount : rawCount

  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const answers = Array.isArray(body.answers) ? body.answers.map((a) => numberValue(a) ?? -1) : null
  if (!answers || answers.length !== expectedCount) {
    res.status(400).json({ success: false, message: `answers massivi ${expectedCount} ta elementdan iborat bo'lishi kerak` })
    return
  }

  const { submission } = await submitExamAnswers(content.id, sId, fullNameOf(req.user), studentGroupId(req.user), answers, sessionIds ?? undefined, session?.optionPerms, content.maxScore)

  // Sessiyani o'chirish — keyingi urinishda yangi random savollar keladi
  await deleteExamSession(content.id, sId)

  res.status(201).json({ success: true, data: { submission, maxScore: content.maxScore } })
})

/* ── Davomat (qo'lda) ───────────────────────────────────────────────── */
function isValidAttendanceStatus(value: unknown): value is AttendanceStatus {
  return value === "present" || value === "absent" || value === "excused" || value === "late"
}

function isValidDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime())
}

/* ── GET /attendance/roster — guruh ro'yxati + shu kun uchun davomat ── */
router.get("/attendance/roster", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = numberValue(req.query.groupId)
  const subjectName = textValue(req.query.subject)
  const date = textValue(req.query.date)
  if (groupId === null || !subjectName || !isValidDateOnly(date)) {
    res.status(400).json({ success: false, message: "groupId, subject va date (YYYY-MM-DD) majburiy" })
    return
  }

  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  const [hemisRoster, existing] = await Promise.all([
    getGroupRoster(groupId).catch(() => [] as import("../services/attendanceStore").RosterStudent[]),
    getAttendanceForGroupDate(groupId, subjectName, date),
  ])

  // If HEMIS roster is empty, fall back to students from attendance history
  let roster = hemisRoster
  if (!roster.length) {
    const [attRows] = await pool.query<import("mysql2").RowDataPacket[]>(
      `SELECT DISTINCT student_user_id, student_full_name FROM lms_attendance
       WHERE group_id = ? AND LOWER(subject_name) = LOWER(?) ORDER BY student_full_name`,
      [groupId, subjectName]
    )
    roster = attRows.map(r => ({
      studentUserId: Number(r.student_user_id),
      fullName: String(r.student_full_name),
      studentIdNumber: null,
    }))
  }

  const data = roster.map((s) => {
    const record = existing.get(s.studentUserId)
    return {
      studentUserId: s.studentUserId,
      fullName: s.fullName,
      studentIdNumber: s.studentIdNumber,
      status: record?.status ?? null,
      comment: record?.comment ?? null,
    }
  })

  res.json({ success: true, data })
})

/* ── POST /attendance — davomatni saqlash ──────────────────────────── */
router.post("/attendance", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi davomat belgilay oladi" })
    return
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const groupId = numberValue(body.groupId)
  const subjectName = textValue(body.subjectName)
  const date = textValue(body.date)
  const records = Array.isArray(body.records) ? body.records : null

  if (groupId === null || !subjectName || !isValidDateOnly(date) || !records) {
    res.status(400).json({ success: false, message: "groupId, subjectName, date va records majburiy" })
    return
  }

  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  const parsed: AttendanceRecordInput[] = []
  for (const item of records) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const status = r.status
    const studentId = numberValue(r.studentUserId)
    if (studentId === null || !isValidAttendanceStatus(status)) {
      res.status(400).json({ success: false, message: "records ichidagi har bir element studentUserId va to'g'ri status'ga ega bo'lishi kerak" })
      return
    }
    parsed.push({
      studentUserId: studentId,
      fullName: textValue(r.fullName) || "Talaba",
      status,
      comment: textValue(r.comment) || null,
    })
  }

  await saveAttendance(groupId, subjectName, date, parsed, tId)
  res.json({ success: true, message: "Davomat saqlandi" })
})

/* ── GET /attendance — o'qituvchi uchun tarix/hisobot ──────────────── */
router.get("/attendance", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = numberValue(req.query.groupId)
  if (groupId === null) {
    res.status(400).json({ success: false, message: "groupId majburiy" })
    return
  }
  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }
  const subjectName = textValue(req.query.subject) || undefined
  const from = textValue(req.query.from) || undefined
  const to = textValue(req.query.to) || undefined
  const data = await getGroupAttendanceHistory(groupId, subjectName, from, to)
  res.json({ success: true, data })
})

/* ── GET /attendance/me — talabaning o'z davomati ──────────────────── */
router.get("/attendance/me", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const subjectName = textValue(req.query.subject) || undefined
  const from = textValue(req.query.from) || undefined
  const to = textValue(req.query.to) || undefined
  const data = await getStudentAttendance(studentUserId(req.user), subjectName, from, to)
  res.json({ success: true, data })
})

/* ── GET /attendance/sessions — o'qituvchi uchun guruh sessiyalari ─── */
router.get("/attendance/sessions", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = Number(req.query.groupId)
  const date = String(req.query.date || new Date().toISOString().slice(0, 10))
  if (!groupId) {
    res.status(400).json({ success: false, message: "groupId kerak" })
    return
  }
  const data = await getGroupSessions(groupId, date)
  res.json({ success: true, data })
})

/* ── GET /attendance/sessions/me — talabaning o'z sessiyalari ────── */
router.get("/attendance/sessions/me", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role === "employee") {
    res.status(403).json({ success: false, message: "Faqat talaba uchun" })
    return
  }
  const from = String(req.query.from || "")
  const to   = String(req.query.to   || "")
  const data = await getStudentSessions(
    studentUserId(req.user),
    from || undefined,
    to   || undefined
  )
  res.json({ success: true, data })
})

/* ── Baholash (qo'lda) ─────────────────────────────────────────────── */
function isValidGrade(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
}

/* ── GET /grades/roster — guruh ro'yxati + shu kun uchun baho ───────── */
router.get("/grades/roster", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = numberValue(req.query.groupId)
  const subjectName = textValue(req.query.subject)
  const date = textValue(req.query.date)
  if (groupId === null || !subjectName || !isValidDateOnly(date)) {
    res.status(400).json({ success: false, message: "groupId, subject va date (YYYY-MM-DD) majburiy" })
    return
  }

  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  const [roster, existing] = await Promise.all([
    getGroupRoster(groupId),
    getGradeForGroupDate(groupId, subjectName, date),
  ])

  const data = roster.map((s) => {
    const record = existing.get(s.studentUserId)
    return {
      studentUserId: s.studentUserId,
      fullName: s.fullName,
      studentIdNumber: s.studentIdNumber,
      grade: record?.grade ?? null,
      comment: record?.comment ?? null,
    }
  })

  res.json({ success: true, data })
})

/* ── POST /grades — bahoni saqlash ───────────────────────────────────── */
router.post("/grades", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi baho qo'ya oladi" })
    return
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const groupId = numberValue(body.groupId)
  const subjectName = textValue(body.subjectName)
  const date = textValue(body.date)
  const records = Array.isArray(body.records) ? body.records : null

  if (groupId === null || !subjectName || !isValidDateOnly(date) || !records) {
    res.status(400).json({ success: false, message: "groupId, subjectName, date va records majburiy" })
    return
  }

  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  const parsed: GradeRecordInput[] = []
  for (const item of records) {
    const r = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const studentId = numberValue(r.studentUserId)
    const grade = r.grade === null ? null : numberValue(r.grade)
    if (studentId === null || !isValidGrade(grade)) {
      res.status(400).json({ success: false, message: "records ichidagi har bir element studentUserId va 0-100 oralig'idagi baho (yoki null) ga ega bo'lishi kerak" })
      return
    }
    parsed.push({
      studentUserId: studentId,
      fullName: textValue(r.fullName) || "Talaba",
      grade,
      comment: textValue(r.comment) || null,
    })
  }

  await saveGrade(groupId, subjectName, date, parsed, tId)
  res.json({ success: true, message: "Baholar saqlandi" })
})

/* ── GET /grade-journal — to'liq jurnal: mavzular, JN, ON, YN, davomat ─ */
router.get("/grade-journal", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = numberValue(req.query.groupId)
  const subjectName = textValue(req.query.subject)
  if (groupId === null || !subjectName) {
    res.status(400).json({ success: false, message: "groupId va subject majburiy" })
    return
  }
  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  const allContent = await listTeacherContent({ teacherUserId: tId, groupId, subjectName })

  // Topiclarni topic_key bo'yicha guruhlash, sana bo'yicha tartiblash
  const topicMap = new Map<string, { minDate: number; items: TeacherContentRecord[] }>()
  for (const c of allContent) {
    const key = c.topicKey ?? ""
    if (!key) continue
    if (!topicMap.has(key)) topicMap.set(key, { minDate: new Date(c.availableFrom).getTime(), items: [] })
    const entry = topicMap.get(key)!
    const d = new Date(c.availableFrom).getTime()
    if (d < entry.minDate) entry.minDate = d
    entry.items.push(c)
  }

  const topics = Array.from(topicMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([key, { items }], idx) => {
      const mavzuItem = items.find(c => c.type === "mavzu") ?? items[0]
      // Only exam and assignment items count toward score
      const maxScore = items.reduce((s, c) => {
        if (c.type === "exam" || c.type === "assignment") return s + (c.maxScore ?? 0)
        return s
      }, 0)
      return { key, idx: idx + 1, title: mavzuItem?.title ?? key, maxScore }
    })

  const roster = await getGroupRoster(groupId)
  if (!roster.length || !topics.length) {
    res.json({ success: true, data: { topics, students: [] } })
    return
  }

  const contentIds = allContent.filter(c => c.topicKey).map(c => c.id)
  const studentIds = roster.map(s => s.studentUserId)

  const [progressList, submissionList, periodGradeList, attList] = await Promise.all([
    getProgressBulk(contentIds, studentIds),
    getSubmissionsBulk(contentIds, studentIds),
    getPeriodGrades(groupId, subjectName),
    getAttendanceSummary(groupId, subjectName),
  ])

  // Lookup maps
  const progressMap = new Map<string, boolean>()
  for (const p of progressList) progressMap.set(`${p.contentId}:${p.studentUserId}`, p.completed)

  const subMap = new Map<string, number | null>()
  for (const s of submissionList) subMap.set(`${s.contentId}:${s.studentUserId}`, s.grade)

  const periodMap = new Map<string, number | null>()
  for (const g of periodGradeList) periodMap.set(`${g.studentUserId}:${g.gradeType}`, g.grade)

  const attMap = new Map<number, number>()
  for (const a of attList) {
    attMap.set(a.studentUserId, a.total > 0 ? Math.round((a.present / a.total) * 100) : 0)
  }

  const students = roster.map(s => {
    const topicScores: Record<string, number | null> = {}

    for (const { key, items } of Array.from(topicMap.entries()).map(([k, v]) => ({ key: k, ...v }))) {
      let earned = 0; let hasActivity = false
      for (const c of items) {
        if (c.type === "exam" || c.type === "assignment") {
          const g = subMap.get(`${c.id}:${s.studentUserId}`)
          if (g !== undefined) { earned += normalizeGrade(g, c.maxScore); hasActivity = true }
        }
      }
      topicScores[key] = hasActivity ? earned : null
    }

    // Average of submitted topic scores (only topics where student has activity)
    // Each topic score is converted to 0-100 percentage using its maxScore (default 100)
    const submittedPcts = topics
      .filter(t => topicScores[t.key] !== null && topicScores[t.key] !== undefined)
      .map(t => {
        const earned = topicScores[t.key] as number
        const max = t.maxScore > 0 ? t.maxScore : 100
        return Math.min(100, Math.round((earned / max) * 100 * 10) / 10)
      })
    const jn = submittedPcts.length > 0
      ? Math.round(submittedPcts.reduce((a, b) => a + b, 0) / submittedPcts.length * 10) / 10
      : null

    const on1 = periodMap.get(`${s.studentUserId}:ON1`) ?? null
    const on2 = periodMap.get(`${s.studentUserId}:ON2`) ?? null
    const yn  = periodMap.get(`${s.studentUserId}:YN`)  ?? null

    return {
      userId: s.studentUserId,
      fullName: s.fullName,
      studentIdNumber: s.studentIdNumber ?? null,
      topicScores,
      jn,
      on1,
      on2,
      yn,
      attendancePct: attMap.get(s.studentUserId) ?? null,
    }
  })

  res.json({ success: true, data: { topics, students } })
})

/* ── POST /period-grade — ON1/ON2/YN bahosini saqlash ───────────────── */
router.post("/period-grade", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const groupId   = numberValue(body.groupId)
  const subjectName = textValue(body.subjectName)
  const studentId = numberValue(body.studentUserId)
  const gradeType = textValue(body.gradeType)
  const grade     = body.grade === null ? null : numberValue(body.grade)

  if (groupId === null || !subjectName || studentId === null || !gradeType) {
    res.status(400).json({ success: false, message: "groupId, subjectName, studentUserId, gradeType majburiy" })
    return
  }
  const allowed = ["ON1", "ON2", "YN"]
  if (!allowed.includes(gradeType)) {
    res.status(400).json({ success: false, message: `gradeType faqat: ${allowed.join(", ")}` })
    return
  }

  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  await upsertPeriodGrade(groupId, subjectName, studentId, gradeType, grade !== undefined ? grade : null, tId)
  res.json({ success: true })
})

/* ── GET /exam-results — o'qituvchi: guruh bo'yicha test natijalari ──── */
router.get("/exam-results", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = numberValue(req.query.groupId)
  const subjectName = textValue(req.query.subject)
  if (groupId === null || !subjectName) {
    res.status(400).json({ success: false, message: "groupId va subject majburiy" })
    return
  }
  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }

  const exams = (await listTeacherContent({ teacherUserId: tId, groupId, subjectName, type: "exam" }))
    .sort((a, b) => new Date(a.availableFrom).getTime() - new Date(b.availableFrom).getTime())

  const [subsPerExam, roster] = await Promise.all([
    Promise.all(exams.map(e => listSubmissions(e.id))),
    getGroupRoster(groupId),
  ])

  const topics = exams.map((e, i) => ({
    id: e.id,
    title: e.title,
    topicKey: e.topicKey ?? null,
    maxScore: e.maxScore ?? null,
    availableFrom: e.availableFrom,
    totalSubmitted: subsPerExam[i].length,
  }))

  const students = roster.map(s => {
    const scores: Record<number, number | null> = {}
    exams.forEach((e, i) => {
      const sub = subsPerExam[i].find(sub => sub.studentUserId === s.studentUserId)
      scores[e.id] = sub?.grade ?? null
    })
    const total = Object.values(scores).reduce<number>((sum, g) => sum + (g ?? 0), 0)
    return { userId: s.studentUserId, fullName: s.fullName, studentIdNumber: s.studentIdNumber ?? null, scores, total }
  })

  res.json({ success: true, data: { topics, students } })
})

/* ── GET /grades — o'qituvchi uchun tarix/hisobot ────────────────────── */
router.get("/grades", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee") {
    res.status(403).json({ success: false, message: "Faqat o'qituvchi uchun" })
    return
  }
  const groupId = numberValue(req.query.groupId)
  if (groupId === null) {
    res.status(400).json({ success: false, message: "groupId majburiy" })
    return
  }
  const tId = teacherUserId(req.user)
  const ownGroupIds = await getTeacherGroupIds(tId)
  if (!ownGroupIds.includes(groupId)) {
    res.status(403).json({ success: false, message: "Bu guruh sizga HEMIS orqali biriktirilmagan" })
    return
  }
  const subjectName = textValue(req.query.subject) || undefined
  const from = textValue(req.query.from) || undefined
  const to = textValue(req.query.to) || undefined
  const data = await getGroupGradeHistory(groupId, subjectName, from, to)
  res.json({ success: true, data })
})

/* ── POST /notify-student — Telegram orqali talabaga xabar yuborish ─── */
router.post("/notify-student", async (req: AuthRequest, res: Response): Promise<void> => {
  if (req.user?.role !== "employee" && req.user?.role !== "admin") {
    res.status(403).json({ success: false, message: "Ruxsat yo'q" }); return
  }
  const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {}
  const studentName = textValue(body.studentName)
  const message     = textValue(body.message)
  const stats       = body.stats as Record<string, unknown> | undefined
  const studentUserIdRaw = body.studentUserId
  const studentUserId = typeof studentUserIdRaw === "number"
    ? studentUserIdRaw
    : typeof studentUserIdRaw === "string" && studentUserIdRaw.trim() && Number.isFinite(Number(studentUserIdRaw))
      ? Number(studentUserIdRaw)
      : null

  if (!studentName || !message) {
    res.status(400).json({ success: false, message: "studentName va message majburiy" }); return
  }

  // Platforma ichidagi xabarnoma — talaba LMS'ga kirganda "Xabarnomalar" bo'limida
  // ko'radi. Telegram sozlanmagan/xato bo'lsa ham bu mustaqil ishlaydi.
  let platformNotified = false
  if (studentUserId !== null) {
    const subjectLine = stats?.subject ? ` (${textValue(stats.subject)})` : ""
    notifications.push({
      id: randomUUID(),
      type: "teacher",
      title: `O'qituvchidan xabar${subjectLine}`,
      body: message,
      time: new Date().toLocaleString("uz-UZ"),
      read: false,
      userId: String(studentUserId),
    })
    platformNotified = true
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN
  const chatId   = process.env.TELEGRAM_CHAT_ID
  if (!botToken || !chatId) {
    if (platformNotified) {
      res.json({ success: true, message: "Platformaga xabar yuborildi (Telegram sozlanmagan)" })
      return
    }
    res.status(503).json({ success: false, message: "Telegram bot sozlanmagan (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID kerak)" }); return
  }

  const lines: string[] = [
    `🔔 <b>Talaba hisoboti</b>`,
    ``,
    `👤 <b>${studentName}</b>`,
  ]
  if (stats) {
    if (stats.subject)       lines.push(`📚 <b>Fan:</b> ${stats.subject}`)
    if (stats.jn != null)    lines.push(`📊 <b>JN (joriy nazorat):</b> ${stats.jn}%`)
    if (stats.topics)        lines.push(`📖 <b>Mavzular:</b> ${stats.topics}`)
    if (stats.on1 != null)   lines.push(`📝 <b>ON1:</b> ${stats.on1}`)
    if (stats.on2 != null)   lines.push(`📝 <b>ON2:</b> ${stats.on2}`)
    if (stats.yn  != null)   lines.push(`📝 <b>YN:</b>  ${stats.yn}`)
    if (stats.attendance != null) lines.push(`🏫 <b>Davomat:</b> ${stats.attendance}%`)
  }
  lines.push(``, `💬 <b>O'qituvchi xabari:</b>`)
  lines.push(message)
  lines.push(``, `— <i>SamISI LMS tizimi orqali yuborildi</i>`)

  const text = lines.join("\n")

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    })
    const json = await resp.json() as { ok: boolean; description?: string }
    if (!json.ok) {
      if (platformNotified) {
        res.json({ success: true, message: `Platformaga yuborildi (Telegram xatosi: ${json.description ?? "noma'lum"})` })
        return
      }
      res.status(502).json({ success: false, message: `Telegram xatosi: ${json.description ?? "noma'lum"}` }); return
    }
    res.json({ success: true, message: platformNotified ? "Telegram va platformaga yuborildi" : "Xabar yuborildi" })
  } catch (e) {
    if (platformNotified) {
      res.json({ success: true, message: "Platformaga yuborildi (Telegramga ulanib bo'lmadi)" })
      return
    }
    res.status(502).json({ success: false, message: `Telegram ga ulanib bo'lmadi: ${e instanceof Error ? e.message : "noma'lum"}` })
  }
})

export default router
