import { TEACHER_PAGES, type GuidePage } from "./assistantGuide"

/* ── O'qituvchi yordamchisi: o'z serverimizdagi model (Ollama) bilan suhbat ──
 * Bepul va ma'lumot tashqariga chiqmaydi: so'rov faqat OLLAMA_URL ga ketadi.
 *   OLLAMA_URL       — standart http://127.0.0.1:11434
 *   OLLAMA_MODEL     — standart qwen3:8b
 *   ASSISTANT_THINK  — "1": material yaratishda modelning "o'ylash" rejimi
 *                      (sifatliroq, lekin 2–3 barobar sekin — GPU bo'lsa yoqing)
 *
 * Server GPU'siz (protsessorda) ishlaydi, kichik (8B) model esa hamma ishni
 * ishonchli qila olmaydi. Shuning uchun modelga iloji boricha kam ish qoladi:
 *   1) "och" / "ha" / "tushuntir", salomlashish, sahifani topish (kalit so'zlar) —
 *      kod bilan, modelsiz, bir zumda;
 *   2) tushuntirish matni qo'llanmadan (assistantGuide.ts) aynan olinadi —
 *      model matn to'qimaydi, xato bo'lmaydi;
 *   3) faqat erkin savol va material yaratish (topshiriq namunasi, test
 *      savollari) modelga boradi. Tizim ko'rsatmasi qisqa va O'ZGARMAS
 *      (Ollama uni keshlaydi — protsessorda har safar qayta o'qimaydi);
 *   4) javob oqim bilan (so'zma-so'z) qaytadi — o'qituvchi kutib o'tirmaydi. */

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "")
export const ASSISTANT_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b"
const TIMEOUT_MS = Number(process.env.ASSISTANT_TIMEOUT_MS || 300_000)
const THINK = process.env.ASSISTANT_THINK === "1"
// OLLAMA_NUM_GPU=0 — faqat protsessorda ishlatish. Serverda Ollama kuchsiz o'rnatilgan
// videochipni "GPU" deb topib, modelning 82% ini unga yuklagan va javob qotib qolgan (2026-11-11).
const GPU_OPTION: Record<string, number> = /^\d+$/.test(process.env.OLLAMA_NUM_GPU ?? "")
  ? { num_gpu: Number(process.env.OLLAMA_NUM_GPU) }
  : {}

export interface ChatTurn {
  role: "user" | "assistant"
  content: string
}

export interface AssistantAnswer {
  reply: string
  page: string | null
  openNow: boolean
}

/** Javob bo'lagi kelganda chaqiriladi (oqim) */
export type OnDelta = (text: string) => void

// Bitta model — so'rovlar navbat bilan
let queue: Promise<unknown> = Promise.resolve()

async function ollamaChat(body: Record<string, unknown>, onDelta?: OnDelta): Promise<string> {
  const run = async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: ASSISTANT_MODEL, stream: true, think: false, keep_alive: "2h", ...body,
          options: { ...(body.options as Record<string, unknown> | undefined), ...GPU_OPTION },
        }),
      })
      if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`)
      // Ollama oqimi: har qatorda bitta JSON ({ message: { content }, done })
      const decoder = new TextDecoder()
      let buffer = ""
      let full = ""
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          try {
            const piece = (JSON.parse(line) as { message?: { content?: string } }).message?.content ?? ""
            if (piece) { full += piece; onDelta?.(piece) }
          } catch { /* to'liq bo'lmagan qator — o'tkazib yuboriladi */ }
        }
      }
      return full
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

/** Model javobida nomi tilga olingan sahifa — tagiga "ochish" tugmasi chiqadi */
function pageMentioned(reply: string): GuidePage | null {
  const t = norm(reply)
  let best: GuidePage | null = null
  let bestLen = 0
  for (const p of TEACHER_PAGES) {
    const name = norm(p.title.split(" (")[0])
    if (name.length > 5 && name.length > bestLen && t.includes(name)) { best = p; bestLen = name.length }
  }
  return best
}

/* ── 2) Qo'llanmadan aynan olinadigan va tayyor javoblar ───────────── */

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

const HELLO_REPLY = "Assalomu alaykum! Men LMS yordamchiman. Saytdan foydalanishni tushuntiraman, kerakli sahifani ochib beraman, mavzu bo'yicha topshiriq namunasi yoki test savollari tayyorlab beraman. Nima qilmoqchisiz?"
const ABOUT_REPLY = "Men uch xil ishda yordam beraman:\n1) Saytni tushuntiraman: masalan \"davomatni qanday belgilayman?\"\n2) Sahifani ochib beraman: masalan \"baholash sahifasini och\"\n3) Material tayyorlayman: masalan \"Marketing asoslari mavzusidan 5 ta test savoli tuzib ber\"\nBaho qo'yish yoki o'chirish kabi amallarni o'zim bajarmayman — sahifani ochib, qanday qilinishini aytaman."
const THANKS_REPLY = "Arzimaydi! Yana savol bo'lsa, yozing."
const MODEL_DOWN_REPLY = "Model serveri hozir ishlamayapti, shuning uchun bu savolga javob bera olmayman. Sahifalar bo'yicha yordam bera olaman — sahifa nomini yozing, masalan: \"baholash\", \"davomat\", \"oraliq nazorat\", \"meeting\"."
const EMPTY_REPLY = "Javob bera olmadim, savolni boshqacha yozib ko'ring."

/** Salomlashish, "nima qila olasan", rahmat — modelsiz */
function cannedReply(text: string): string | null {
  const t = norm(text).replace(/[.!?,]+/g, " ").trim()
  const words = t.split(" ").length
  if (words <= 5 && /^(salom|assalom|assalomu alaykum|va alaykum|hayrli|xayrli|hello|hi|привет|здравствуйте)/.test(t)) return HELLO_REPLY
  if (words <= 8 && /(nima qila olasan|nimalar qila olasan|kimsan|sen kim|nima uchun kerak|qanday yordam|yordam bera olasan|что ты умеешь|what can you do)/.test(t)) return ABOUT_REPLY
  if (words <= 4 && /^(rahmat|raxmat|katta rahmat|tashakkur|спасибо|thanks|thank you)/.test(t)) return THANKS_REPLY
  return null
}

/* ── 3) Model: erkin savol va material yaratish ────────────────────── */

const STYLE = "Javobni o'zbek tilida, lotin yozuvida yoz. Markdown ishlatma (yulduzcha, panjara, jadval yo'q). Ro'yxat kerak bo'lsa \"1) ...\" ko'rinishida, har bandni yangi qatordan yoz."

function cleanText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[*-]\s+/gm, "• ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

// O'ZGARMAS tizim ko'rsatmalari: Ollama boshini keshlaydi — protsessorda har safar qayta o'qilmaydi.
// (O'zgaruvchan narsa — joriy sahifa — tizim ko'rsatmasiga emas, savolning o'ziga qo'shiladi.)

const CREATE_SYSTEM = [
  "Sen oliy ta'lim muassasasida ishlaydigan tajribali o'qituvchi-metodistsan. O'qituvchi so'ragan o'quv materialini tayyorlab ber: amaliy topshiriq namunasi, test savollari, dars rejasi, baholash mezoni, e'lon matni va shunga o'xshashlar.",
  "Talablar:",
  "- So'ralgan narsaning o'zini yoz; kirish so'zisiz boshla, so'ralmagan narsani qo'shma.",
  "- Topshiriq namunasi: sarlavha, maqsad, topshiriq sharti (aniq, bajarsa bo'ladigan), bajarish tartibi, topshirish shakli, baholash mezoni (ballarda).",
  "- Test savollari: har savolda 4 ta HAR XIL variant (A, B, C, D), faqat bittasi to'g'ri, va alohida qatorda \"To'g'ri javob: ...\". Savollar bir-birini takrorlamasin, mavzuga oid va faktik jihatdan to'g'ri bo'lsin.",
  "- Fakt yoki sonni aniq bilmasang, o'ylab topma — umumiyroq yoz.",
  STYLE,
].join("\n")

const CHAT_SYSTEM = [
  "Sen SamISI LMS (masofaviy ta'lim tizimi) ichidagi o'qituvchi yordamchisisan. Isming — LMS yordamchi.",
  "Sayt haqidagi savolga FAQAT quyidagi ma'lumot asosida javob ber. Javob unda bo'lmasa, aynan shunday de: \"Bu haqda aniq ma'lumotim yo'q. Yo'riqnoma bo'limiga qarang yoki adminga murojaat qiling.\" Hech narsani o'ylab topma.",
  "Qaysi sahifada qilinishini aytganda sahifa nomini aynan yoz. LMS va ta'limga aloqasi yo'q savolga: \"Men faqat LMS va dars materiallari bo'yicha yordam bera olaman.\"",
  "Qisqa javob ber (ko'pi bilan 4 gap).",
  STYLE,
  "",
  "SAHIFALAR:",
  ...TEACHER_PAGES.map((p) => `- ${p.title}: ${p.purpose}`),
  "",
  "QOIDALAR:",
  "- Guruhlar va dars jadvali HEMIS'dan olinadi; mavzular, materiallar, testlar, topshiriqlar va baholar LMS'da saqlanadi.",
  "- Ma'ruza qismi = ON1 + ON2 + mustaqil ishlar; Amaliyot qismi = JN (amaliy topshiriqlar) + mustaqil ishlar; oxirida yakuniy nazorat (YN).",
  "- Test ballari avtomatik qo'yiladi; topshiriq fayllarini o'qituvchi Baholash sahifasida baholaydi.",
  "- Davomat saqlangach qulflanadi; o'zgartirish uchun tahrirlash so'rovi yuboriladi va admin tasdiqlaydi.",
  "- Test va oraliq nazoratda talaba Face ID tekshiruvidan o'tadi.",
].join("\n")

async function createMaterial(history: ChatTurn[], onDelta?: OnDelta): Promise<string> {
  const raw = await ollamaChat({
    // Faqat oxirgi so'rov (va undan oldingi bitta juftlik — "yana 3 ta qo'sh" kabi davom uchun)
    messages: [{ role: "system", content: CREATE_SYSTEM }, ...history.slice(-3)],
    think: THINK,
    options: { temperature: 0.5, num_ctx: 4096, num_predict: 1400, repeat_penalty: 1.15 },
  }, onDelta)
  return cleanText(raw)
}

async function freeChat(history: ChatTurn[], currentPage: string | null, onDelta?: OnDelta): Promise<string> {
  const recent = history.slice(-4)
  const here = findPage(currentPage)
  // Joriy sahifa — savolga qo'shiladi (tizim ko'rsatmasi o'zgarmasin: kesh ishlashi uchun)
  if (here) {
    const last = recent[recent.length - 1]
    recent[recent.length - 1] = { ...last, content: `${last.content}\n(Men hozir «${here.title}» sahifasidaman.)` }
  }
  const raw = await ollamaChat({
    messages: [{ role: "system", content: CHAT_SYSTEM }, ...recent],
    options: { temperature: 0.2, num_ctx: 4096, num_predict: 260 },
  }, onDelta)
  return cleanText(raw)
}

/**
 * @param lastPage oldingi javobda taklif qilingan sahifa — "och" / "ha" / "tushuntir" shunga tegishli
 * @param onDelta  model javobi bo'laklab kelganda (oqim); tayyor javoblarda chaqirilmaydi
 */
export async function askAssistant(
  history: ChatTurn[], currentPage: string | null, lastPage: string | null, onDelta?: OnDelta
): Promise<AssistantAnswer> {
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

  const canned = cannedReply(text)
  if (canned) return { reply: canned, page: null, openNow: false }

  try {
    // Material yozib berish so'rovi — to'g'ridan-to'g'ri yaratishga
    if (isCreateRequest(text)) {
      const reply = await createMaterial(history, onDelta)
      const forResources = /(test|savol|topshiriq)/.test(norm(text))
      return { reply: reply || EMPTY_REPLY, page: forResources ? "/oqituvchi-kabineti/fan-resurslari" : null, openNow: false }
    }

    // Sahifa so'zlar bo'yicha topildi — modelsiz
    const target = keywordPage(text)
    if (target) {
      if (isOpenCommand(text)) return { reply: openedReply(target), page: target.path, openNow: true }
      return isExplainCommand(text)
        ? { reply: explainReply(target), page: target.path, openNow: false }
        : { reply: choiceReply(target), page: target.path, openNow: false }
    }

    // Qolgan hammasi — erkin savol; javobda tilga olingan sahifaga tugma chiqadi
    const reply = await freeChat(history, currentPage, onDelta)
    const unknown = /ma'lumotim yo'q|faqat lms/.test(norm(reply))
    const mentioned = unknown ? null : pageMentioned(reply)
    return { reply: reply || EMPTY_REPLY, page: mentioned?.path ?? null, openNow: false }
  } catch (err) {
    console.warn("[assistant] model javob bermadi:", err instanceof Error ? err.message : err)
    return { reply: MODEL_DOWN_REPLY, page: null, openNow: false }
  }
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

/** Server ishga tushganda modelni xotiraga yuklab, tizim ko'rsatmasini keshlab qo'yadi —
    birinchi savol uzoq kutmasin (protsessorda model yuklash 20–60 s oladi). Xato bo'lsa jim. */
export function warmUpAssistant(): void {
  void assistantHealth().then((h) => {
    if (!h.ok) return
    return ollamaChat({
      messages: [{ role: "system", content: CHAT_SYSTEM }, { role: "user", content: "Salom" }],
      options: { temperature: 0, num_ctx: 4096, num_predict: 1 },
    }).then(() => console.log(`✓ Yordamchi modeli tayyor (${ASSISTANT_MODEL})`))
  }).catch(() => undefined)
}
