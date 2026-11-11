import { TEACHER_PAGES, TEACHER_PATHS, teacherGuideText, type GuidePage } from "./assistantGuide"

/* ── O'qituvchi yordamchisi: o'z serverimizdagi model (Ollama) bilan suhbat ──
 * Bepul va ma'lumot tashqariga chiqmaydi: so'rov faqat OLLAMA_URL ga ketadi.
 *   OLLAMA_URL    — standart http://127.0.0.1:11434 (GPU'li boshqa server bo'lsa — uning manzili)
 *   OLLAMA_MODEL  — standart qwen3:8b
 *
 * Kichik (7–8B) model hamma ishni bitta so'rovda ishonchli qila olmaydi
 * (sinovda: so'ramasdan sahifa ochdi, qo'llanmada yo'q narsani o'ylab topdi).
 * Shuning uchun ish bo'lingan:
 *   1) model faqat NIYAT va SAHIFAni aniqlaydi (qat'iy JSON);
 *   2) "tushuntir" / "ochaymi?" javoblari qo'llanmadan (assistantGuide.ts) aynan
 *      olinadi — model matn to'qimaydi, xato bo'lmaydi;
 *   3) "och" buyrug'i kod bilan aniqlanadi — sahifa faqat so'ralganda ochiladi;
 *   4) material yaratish (topshiriq namunasi, test savollari) va erkin savollar —
 *      alohida, erkin matnli so'rov. */

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "")
export const ASSISTANT_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b"
const TIMEOUT_MS = Number(process.env.ASSISTANT_TIMEOUT_MS || 120_000)

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export interface AssistantAnswer {
  reply: string
  page: string | null
  openNow: boolean
}

type Intent = "open" | "howto" | "create" | "chat" | "offtopic"

// Bitta GPU — so'rovlar navbat bilan
let queue: Promise<unknown> = Promise.resolve()

async function ollamaChat(body: Record<string, unknown>): Promise<string> {
  const run = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ model: ASSISTANT_MODEL, stream: false, think: false, keep_alive: "30m", ...body }),
      })
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
      const data = (await res.json()) as { message?: { content?: string } }
      return data.message?.content ?? ""
    } finally {
      clearTimeout(timer)
    }
  }
  const job = queue.then(run)
  queue = job.catch(() => undefined)
  return job
}

/* ── 1) Buyruqlarni kod bilan aniqlash ─────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/[`´‘’ʻʼ]/g, "'").replace(/\s+/g, " ").trim()

/** "och", "ha och", "ochib ber", "o'sha sahifaga o't", "открой" — sahifani ochish buyrug'i */
function isOpenCommand(text: string): boolean {
  const t = norm(text)
  return /(^|\s)(och|ochib|ochgin|oching|ochaver|ochib ber|ochib yubor|o'tkaz|olib bor)(\s|$|[.!,])/.test(t)
    || /(sahifa|bo'lim)(ni|ga|siga|sini)?\s.*(o't|kir|och)/.test(t)
    || /(открой|открыть|перейди|open)/.test(t)
}

/** Qisqa tasdiq: "ha", "mayli", "xo'p" — oldingi "ochaymi?" savoliga javob */
function isYes(text: string): boolean {
  return /^(ha|xa|mayli|xo'p|xop|bo'pti|ok|okay|да|yes)([\s,.!]|$)/.test(norm(text)) && norm(text).length < 25
}

function isExplainCommand(text: string): boolean {
  return /(tushuntir|qanday|qanaqa|qayerda|qayerdan|nima qil|qilinadi|o'rgat|ko'rsat|yo'riqnoma|объясни|как |how )/.test(norm(text))
}

/** "tuzib ber", "yozib ber", "namuna yaratib ber", "5 ta savol tuz" — material YOZIB BERISH so'rovi.
    ("test yaratmoqchiman", "topshiriq qanday beriladi" — bu emas: u saytda ish qilish.) */
function isCreateRequest(text: string): boolean {
  const t = norm(text)
  if (/(moqchiman|qanday|qayerda|qayerdan|kerak edi)/.test(t) && !/\bber(ing)?\b/.test(t)) return false
  return /(tuz|yoz|yarat|tayyorla|ishlab chiq|o'ylab top|shakllantir)(ib)? ?(ber|qo'y)/.test(t)
    || /namuna.*\b(ber|kerak|yoz|tuz|yarat)/.test(t)
    || /\d+\s*ta\s+(test\s+)?(savol|topshiriq|misol|masala)/.test(t)
    || /(составь|напиши|придумай|write|generate|create)\b/.test(t)
}

/** Savoldagi so'zlar bo'yicha sahifa (assistantGuide.ts keywords). Bitta aniq g'olib bo'lsa — o'sha */
function keywordPage(text: string): GuidePage | null {
  const t = norm(text)
  let best: GuidePage | null = null
  let bestScore = 0
  let tie = false
  for (const p of TEACHER_PAGES) {
    // Uzunroq (aniqroq) ibora ko'proq ball
    const score = (p.keywords ?? []).reduce((sum, k) => (t.includes(k) ? sum + k.length : sum), 0)
    if (score > bestScore) { best = p; bestScore = score; tie = false }
    else if (score === bestScore && score > 0) tie = true
  }
  return bestScore > 0 && !tie ? best : null
}

/* ── 2) Niyat va sahifa — model (qat'iy JSON) ──────────────────────── */

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["open", "howto", "chat", "offtopic"] },
    page: { type: ["string", "null"], enum: [...TEACHER_PATHS, null] },
  },
  required: ["intent", "page"],
}

function classifyPrompt(currentPage: string | null): string {
  const pages = TEACHER_PAGES.map((p) => `${p.path} — ${p.title}: ${p.purpose}`).join("\n")
  return [
    "Sen LMS (masofaviy ta'lim tizimi) o'qituvchi yordamchisining yo'naltiruvchi qismisan. O'qituvchining oxirgi xabarini tasnifla va JSON qaytar.",
    "",
    "intent qiymatlari:",
    "- open: sahifani ochishni so'rayapti (\"baholash sahifasini och\", \"davomatga o't\").",
    "- howto: saytda biror ishni qilmoqchi yoki qanday qilinishini so'rayapti (\"topshiriqlarni baholashim kerak\", \"test qanday yaratiladi\", \"davomat qayerda\").",
    "- chat: salomlashish, yordamchi haqida savol yoki LMS/ta'lim haqida umumiy savol.",
    "- offtopic: LMS va ta'limga aloqasi yo'q (ob-havo, siyosat, sport va h.k.).",
    "",
    "page — xabarga eng mos sahifa manzili (faqat ro'yxatdan) yoki null. chat va offtopic uchun null.",
    "",
    "SAHIFALAR:",
    pages,
    currentPage ? `\nO'qituvchi hozir shu sahifada: ${currentPage} (\"bu sahifa\", \"shu yerda\" desa — shu).` : "",
  ].join("\n")
}

async function classify(history: ChatTurn[], currentPage: string | null): Promise<{ intent: Intent; page: string | null }> {
  const raw = await ollamaChat({
    messages: [{ role: "system", content: classifyPrompt(currentPage) }, ...history.slice(-4)],
    format: CLASSIFY_SCHEMA,
    options: { temperature: 0, num_ctx: 4096, num_predict: 80 },
  })
  try {
    const obj = JSON.parse(raw) as { intent?: string; page?: unknown }
    const intent = (["open", "howto", "chat", "offtopic"] as const).find((i) => i === obj.intent) ?? "chat"
    const page = typeof obj.page === "string" && TEACHER_PATHS.includes(obj.page) ? obj.page : null
    return { intent, page }
  } catch {
    return { intent: "chat", page: null }
  }
}

/* ── 3) Qo'llanmadan aynan olinadigan javoblar ─────────────────────── */

const findPage = (path: string | null): GuidePage | null => TEACHER_PAGES.find((p) => p.path === path) ?? null

function explainReply(p: GuidePage): string {
  const steps = p.steps?.length ? `\n\n${p.steps.map((s, i) => `${i + 1}) ${s}`).join("\n")}` : ""
  return `«${p.title}» sahifasi (menyu: ${p.menu}).\n${p.purpose}${steps}\n\nSahifani ochib beraymi?`
}

function choiceReply(p: GuidePage): string {
  return `Bu ish «${p.title}» sahifasida qilinadi (menyu: ${p.menu}). Qanday qilinishini tushuntirib beraymi yoki sahifani ochaymi?`
}

function openedReply(p: GuidePage): string {
  return `«${p.title}» sahifasini ochdim.`
}

/* ── 4) Erkin matnli so'rovlar ─────────────────────────────────────── */

const STYLE = "Javobni o'zbek tilida, lotin yozuvida yoz. Markdown ishlatma (yulduzcha, panjara, jadval yo'q). Ro'yxat kerak bo'lsa \"1) ...\" ko'rinishida, har bandni yangi qatordan yoz."

function cleanText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

async function createMaterial(history: ChatTurn[]): Promise<string> {
  const system = [
    "Sen oliy ta'lim muassasasida ishlaydigan tajribali o'qituvchi-metodistsan. O'qituvchi so'ragan o'quv materialini tayyorlab ber: amaliy topshiriq namunasi, test savollari, dars rejasi, baholash mezoni, e'lon matni va shunga o'xshashlar.",
    "Talablar:",
    "- So'ralgan narsaning o'zini to'liq yoz; ortiqcha kirish so'zisiz boshlа.",
    "- Topshiriq namunasi: sarlavha, maqsad, topshiriq sharti (aniq, bajarsa bo'ladigan), bajarish tartibi, topshirish shakli, baholash mezoni (ballarda).",
    "- Test savollari: har savolda 4 ta HAR XIL variant (A, B, C, D), faqat bittasi to'g'ri, va alohida qatorda \"To'g'ri javob: ...\". Savollar bir-birini takrorlamasin, mavzuga oid va faktik jihatdan to'g'ri bo'lsin.",
    "- Fakt yoki sonni aniq bilmasang, o'ylab topma — umumiyroq yoz.",
    STYLE,
  ].join("\n")
  const raw = await ollamaChat({
    messages: [{ role: "system", content: system }, ...history.slice(-6)],
    // O'ylash rejimi (sinovda: variantlar takrorlanmaydi, mazmun ancha to'g'ri) — sekinroq, lekin sifatliroq
    think: true,
    options: { temperature: 0.5, num_ctx: 8192, num_predict: 2400, repeat_penalty: 1.15 },
  })
  return cleanText(raw)
}

async function freeChat(history: ChatTurn[], currentPage: string | null): Promise<string> {
  const system = [
    "Sen SamISI LMS (masofaviy ta'lim tizimi) ichidagi o'qituvchi yordamchisisan. Isming — LMS yordamchi.",
    "Nima qila olasan: saytdan foydalanishni tushuntirasan, kerakli sahifani ochib berasan, mavzu bo'yicha topshiriq namunasi yoki test savollari tayyorlab berasan. Baho qo'yish, o'chirish kabi amallarni o'zing bajarmaysan.",
    "Sayt haqidagi savolga FAQAT quyidagi qo'llanma asosida javob ber. Qo'llanmada javob bo'lmasa, aynan shunday de: \"Bu haqda aniq ma'lumotim yo'q. Yo'riqnoma bo'limiga qarang yoki adminga murojaat qiling.\" Hech narsani o'ylab topma.",
    "Qisqa javob ber (ko'pi bilan 5 gap).",
    STYLE,
    currentPage ? `O'qituvchi hozir shu sahifada: ${currentPage}` : "",
    "",
    "QO'LLANMA:",
    teacherGuideText(),
  ].join("\n")
  const raw = await ollamaChat({
    messages: [{ role: "system", content: system }, ...history.slice(-6)],
    options: { temperature: 0.2, num_ctx: 8192, num_predict: 400 },
  })
  return cleanText(raw)
}

const OFFTOPIC_REPLY = "Men faqat LMS'dan foydalanish va dars materiallari bo'yicha yordam bera olaman. Masalan: \"topshiriqlarni qanday baholayman?\" yoki \"mavzu bo'yicha test savollari tuzib ber\"."
const MODEL_DOWN_REPLY = "Model serveri hozir ishlamayapti, shuning uchun bu savolga javob bera olmayman. Sahifalar bo'yicha yordam bera olaman — sahifa nomini yozing, masalan: \"baholash\", \"davomat\", \"oraliq nazorat\", \"meeting\"."
const EMPTY_REPLY ="Javob bera olmadim, savolni boshqacha yozib ko'ring."

/**
 * @param lastPage oldingi javobda taklif qilingan sahifa — "och" / "ha" / "tushuntir" shunga tegishli
 */
export async function askAssistant(history: ChatTurn[], currentPage: string | null, lastPage: string | null): Promise<AssistantAnswer> {
  const text = history[history.length - 1].content
  const last = findPage(lastPage)
  const short = norm(text).split(" ").length <= 4

  // Oldingi taklifga qisqa javob ("och", "ha", "tushuntir") — modelsiz, darhol.
  // Xabarda boshqa sahifa yoki boshqa savol bo'lsa (masalan "ob-havo qanday?") — bu emas.
  const t = norm(text).replace(/[.!?,]+$/g, "")
  const bareExplain = /^(ha,? )?(tushuntir\w*( ber\w*)?|tushuntirib ber\w*|qanday( qilinadi| qilaman)?|o'rgat\w*|ko'rsat\w*|объясни|explain)$/.test(t)
  const bareOpen = short && (isYes(text) || isOpenCommand(text)) && !keywordPage(text)
  if (last && bareOpen) return { reply: openedReply(last), page: last.path, openNow: true }
  if (last && bareExplain) return { reply: explainReply(last), page: last.path, openNow: false }

  // Material yozib berish so'rovi — to'g'ridan-to'g'ri yaratishga
  if (isCreateRequest(text)) {
    const reply = await createMaterial(history)
    const forResources = /(test|savol|topshiriq)/.test(norm(text))
    return { reply: reply || EMPTY_REPLY, page: forResources ? "/oqituvchi-kabineti/fan-resurslari" : null, openNow: false }
  }

  // Sahifa: avval so'zlar bo'yicha (tez va aniq), topilmasa — model
  const byKeyword = keywordPage(text)
  let intent: Intent = isOpenCommand(text) ? "open" : "howto"
  let target = byKeyword
  if (!target) {
    try {
      const c = await classify(history, currentPage)
      intent = c.intent
      target = findPage(c.page)
    } catch (err) {
      // Model serveri ishlamayapti: sahifalar bo'yicha yordam (so'z bo'yicha) baribir ishlaydi
      console.warn("[assistant] model javob bermadi:", err instanceof Error ? err.message : err)
      return { reply: MODEL_DOWN_REPLY, page: null, openNow: false }
    }
  }

  if (intent === "offtopic") return { reply: OFFTOPIC_REPLY, page: null, openNow: false }

  if ((intent === "open" || isOpenCommand(text)) && target) {
    return { reply: openedReply(target), page: target.path, openNow: true }
  }

  // Sahifani model taxmin qilgan bo'lsa (so'z bo'yicha topilmagan) — qo'llanma matnini
  // ko'r-ko'rona bermaymiz: savolga qo'llanma asosida javob, bilmasa "ma'lumotim yo'q"
  if (intent === "howto" && target && !byKeyword) {
    const reply = await freeChat(history, currentPage)
    const unknown = /ma'lumotim yo'q/.test(norm(reply))
    return { reply: reply || EMPTY_REPLY, page: unknown ? null : target.path, openNow: false }
  }

  if (intent === "howto" && target) {
    return isExplainCommand(text)
      ? { reply: explainReply(target), page: target.path, openNow: false }
      : { reply: choiceReply(target), page: target.path, openNow: false }
  }

  const reply = await freeChat(history, currentPage)
  return { reply: reply || EMPTY_REPLY, page: null, openNow: false }
}

/** Model serveri ishlayaptimi va model yuklab olinganmi */
export async function assistantHealth(): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { ok: false, reason: `Ollama ${res.status}` }
    const data = (await res.json()) as { models?: Array<{ name?: string }> }
    const has = (data.models ?? []).some((m) => m.name === ASSISTANT_MODEL || m.name === `${ASSISTANT_MODEL}:latest`)
    return has ? { ok: true } : { ok: false, reason: `"${ASSISTANT_MODEL}" modeli yuklab olinmagan` }
  } catch {
    return { ok: false, reason: "Ollama serveriga ulanib bo'lmadi" }
  }
}
