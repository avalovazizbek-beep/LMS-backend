import { listTeacherContent } from "./teachingStore"
import { buildGradeJournal } from "./gradeJournal"
import { pool } from "./db"
import type mysql from "mysql2/promise"

/* ── AI yordamchi: platforma QOIDALARI bo'yicha bilim ─────────────────────
 * "Amaliyot qanday baholanadi?", "Oraliq necha ball?", "Baho qanday chiqadi?"
 * kabi savollarga model emas, shu fayl javob beradi. Matnlar koddagi haqiqiy
 * hisob-kitobdan olingan (services/gradeJournal.ts, periodGrades.ts) — qoida
 * o'zgarsa SHU YERNI ham yangilang, aks holda yordamchi eskisini aytadi.
 * Har javob oxirida o'qituvchining O'Z fanlaridagi haqiqiy sonlar qo'shiladi
 * (nechta amaliy topshiriq, har biri necha ball, oraliqlarga necha ball ajratilgan).
 *
 * Suhbat mavzusi eslab qolinadi: "amaliyot qanday baholanadi" dan keyin
 * "necha ballikda qo'yiladi" deyilsa — bu ham amaliyot haqida. */

export type GradeTopic = "amaliyot" | "maruza" | "oraliq" | "mustaqil" | "yakuniy" | "umumiy"

const norm = (s: string) => s.toLowerCase().replace(/[`´‘’ʻʼ]/g, "'").replace(/\s+/g, " ").trim()

function topicOf(text: string): GradeTopic | null {
  const t = norm(text)
  if (/(amaliy|amaliyot|joriy|\bjn\b|seminar|laboratoriya)/.test(t)) return "amaliyot"
  if (/(oraliq|\bon ?[12]?\b|1-on|2-on)/.test(t)) return "oraliq"
  if (/(mustaqil|\bmi\b)/.test(t)) return "mustaqil"
  if (/(yakuniy|\byn\b|imtihon bali)/.test(t)) return "yakuniy"
  if (/(ma'ruza|maruza|leksiya)/.test(t)) return "maruza"
  if (/(umumiy ball|jami ball|100 ball|yakuniy baho|semestr bah|baho qanday chiq|5 baho|a'lo|qoniqarli|baholash tizimi|ballar taqsimoti|ball taqsimoti|jurnal qanday hisobla)/.test(t)) return "umumiy"
  return null
}

/** Savol baholash QOIDASI haqidami ("qanday baholanadi", "necha ball", "qancha ball beriladi") */
function asksGrading(text: string): boolean {
  const t = norm(text)
  return /(qanday|qanaqa|qay tarzda|qaysi tartibda).*(bahola|hisobla|qo'?yiladi|chiqadi|taqsimla)/.test(t)
    || /(bahola|hisobla)\w*.*(qanday|tartibi|qoidasi)/.test(t)
    || /(necha|nechchi|qancha|nechi)\s*(ball|foiz)/.test(t)
    || /(ball|baho)\w*\s*(necha|qancha|qanday)/.test(t)
    || /(maksimal|eng ko'p|eng yuqori)\s*ball/.test(t)
    || /nima(ga|lar)?\s*(uchun|dan)?\s*ball\s*(ber|qo'sh|olin)/.test(t)
}

/**
 * Savol baholash qoidasi haqida bo'lsa — qaysi mavzu ekanini qaytaradi.
 * Mavzu aytilmagan bo'lsa, suhbatdagi oldingi savollardan olinadi.
 */
export function gradingQuestion(text: string, previousUserTexts: string[]): GradeTopic | null {
  if (!asksGrading(text)) return null
  const own = topicOf(text)
  if (own) return own
  for (const prev of [...previousUserTexts].reverse().slice(0, 4)) {
    const t = topicOf(prev)
    if (t) return t
  }
  // "necha ballikda baholash kerak" — mavzusiz: umumiy tartib
  return /(necha|qancha|nechchi)\s*ball/.test(norm(text)) || /(tizimi|taqsimot)/.test(norm(text)) ? "umumiy" : null
}

/* ── Qoidalar matni (koddan) ───────────────────────────────────────── */

const RULES: Record<GradeTopic, string> = {
  amaliyot: [
    "Amaliyot qismi jami 35 ball. U ikki narsadan yig'iladi: JN (joriy nazorat — amaliy mavzulardagi topshiriq va testlar) va amaliyotdan mustaqil ishlar.",
    "",
    "1) Har bir amaliy mavzudagi ishni o'z shkalasida baholaysiz: topshiriq — uni yaratishda o'zingiz belgilagan maksimal balgacha (masalan 100 balldan yoki 5 balldan), test — avtomatik, 100 ballikda.",
    "2) JN uchun ball = 35 − amaliyotdan mustaqil ishlarga ajratilgan ball. Shu ball amaliy topshiriqlar soniga teng bo'linadi. Masalan: 10 ta amaliy topshiriq va 5 ballik mustaqil ish bo'lsa, JN 30 ball, har topshiriqning ulushi 3 ball.",
    "3) Talabaning natijasi foizga aylanib, shu ulushga ko'paytiriladi: topshiriqdan 80% olgan talaba 3 ballik ulushdan 2.4 ball oladi.",
    "4) JN — shu ulushlar yig'indisi, semestr davomida to'planib boradi va butun songa yaxlitlanadi. Shuning uchun semestr o'rtasida JN past ko'rinadi — bu normal.",
    "5) Muddati o'tgan va topshirilmagan topshiriq 0 ball hisoblanadi. Muddati hali ochiq yoki topshirilgan-u siz hali baholamagan ish hisobga kirmaydi.",
    "6) Ma'ruza mavzularidagi testlar JN'ga ball bermaydi — ular faqat keyingi mavzuni ochadi.",
    "",
    "Qayerda: topshiriq fayllariga bahoni «Baholash» sahifasida qo'yasiz; jurnal «Mavzular bo'yicha natijalar» sahifasida o'zi hisoblaydi.",
  ].join("\n"),
  maruza: [
    "Ma'ruza qismi jami 35 ball: ON1 (birinchi oraliq nazorat) + ON2 (ikkinchi oraliq nazorat) + ma'ruzadan mustaqil ishlar.",
    "",
    "1) Shu 35 ballni o'zingiz taqsimlaysiz: har bir oraliq va mustaqil ishni yaratishda unga necha ball ajratishingizni kiritasiz (masalan ON1 — 10, ON2 — 15, mustaqil ish — 10). Forma qancha ball band, qanchasi bo'sh ekanini ko'rsatib turadi.",
    "2) Ball ajratilmagan eski oraliqlar ON1 — 17, ON2 — 18 ball hisoblanadi.",
    "3) Ma'ruza mavzularidagi testlar ball bermaydi — ular faqat keyingi mavzuni ochish uchun (talaba 60% dan o'tishi kerak).",
    "",
    "Qayerda: oraliq va mustaqil ishlar «Imtihonlar ro'yxati» sahifasida yaratiladi.",
  ].join("\n"),
  oraliq: [
    "Oraliq nazorat (ON1 va ON2) ma'ruza qismining 35 balidan olinadi. Har biriga necha ball ajratishni o'zingiz belgilaysiz (ajratilmagan eski oraliqlar: ON1 — 17, ON2 — 18).",
    "",
    "1) Oraliq test yoki topshiriq shaklida bo'ladi (bittasi tanlanadi).",
    "2) Test bo'lsa: talaba 100 ballik shkalada topshiradi, jurnal foizni siz ajratgan ballga aylantiradi. Masalan oraliqqa 10 ball ajratilgan, talaba 80% oldi — jurnalga 8 ball tushadi.",
    "3) Topshiriq bo'lsa: uni siz ajratgan balldan baholaysiz (10 ball ajratilgan bo'lsa — 10 balldan).",
    "4) Oraliq testda talaba Face ID tekshiruvidan o'tadi; muddat o'tib, natijalar chiqqach oraliqni o'chirib bo'lmaydi.",
    "5) Oraliqqa kelmagan yoki o'ta olmagan talabaga qayta urinishni admin beradi.",
    "",
    "Qayerda: «Imtihonlar ro'yxati» sahifasi → «Yangi qo'shish» → HEMIS'dagi nazoratlardan 1-on yoki 2-on tanlanadi.",
  ].join("\n"),
  mustaqil: [
    "Mustaqil ish (MI) — alohida nazorat. Uni yaratishda ikki narsani belgilaysiz: qaysi qismdan (Ma'ruza yoki Amaliyot) va necha ball.",
    "",
    "1) Ma'ruzadan mustaqil ish ma'ruzaning 35 balidan olinadi (ON1 va ON2 bilan birga 35 dan oshmasligi kerak).",
    "2) Amaliyotdan mustaqil ish amaliyotning 35 balidan olinadi — shuncha ballga JN kamayadi. Masalan 5 ballik amaliyot mustaqil ishi bo'lsa, JN 30 ball bo'ladi.",
    "3) Test shaklida bo'lsa 100 ballikda topshiriladi va foizi ajratilgan ballga aylanadi; topshiriq shaklida bo'lsa ajratilgan balldan baholaysiz.",
    "4) Eski «Fan resurslari»dagi Mustaqil ish mavzulari baholanmaydi — keraklisini yangidan yarating.",
    "",
    "Qayerda: «Imtihonlar ro'yxati» sahifasi → «Mustaqil ish qo'shish».",
  ].join("\n"),
  yakuniy: [
    "Yakuniy nazorat (YN) — 30 ball. Test bo'lsa talaba 100 ballikda topshiradi va foizi 30 ballga aylanadi (80% → 24 ball).",
    "",
    "Umumiy ball = Joriy (70) + Yakuniy (30) = 100. Joriy = Ma'ruza (35) + Amaliyot (35).",
    "Baho yakuniy nazorat natijasi kirgandan keyin chiqadi: 86 va undan yuqori — 5, 71–85 — 4, 55–70 — 3, 55 dan past — 2.",
    "",
    "Qayerda: «Yakuniy nazorat» sahifasida yaratiladi; ON va YN katakchalariga jurnalda qo'lda ham ball kiritish mumkin (katakchani bosib, sonni yozib, Enter).",
  ].join("\n"),
  umumiy: [
    "Fan bo'yicha jami 100 ball:",
    "",
    "1) Ma'ruza — 35 ball: ON1 + ON2 + ma'ruzadan mustaqil ishlar (ballarni o'zingiz taqsimlaysiz).",
    "2) Amaliyot — 35 ball: JN (amaliy mavzulardagi topshiriq va testlar) + amaliyotdan mustaqil ishlar.",
    "3) Joriy = Ma'ruza + Amaliyot = 70 ball.",
    "4) Yakuniy nazorat — 30 ball.",
    "5) Baho yakuniy nazoratdan keyin chiqadi: 86+ — 5, 71–85 — 4, 55–70 — 3, 55 dan past — 2.",
    "",
    "Testlar doim 100 ballikda topshiriladi va foizi ajratilgan ballga aylanadi; topshiriqlarni o'zingiz belgilagan maksimal balldan baholaysiz. Ma'ruza mavzularidagi testlar ball bermaydi.",
    "Batafsil so'rang: \"amaliyot qanday baholanadi\", \"oraliq qanday baholanadi\", \"mustaqil ish\".",
  ].join("\n"),
}

const PAGE: Record<GradeTopic, string> = {
  amaliyot: "/oqituvchi-kabineti/baholash-page",
  maruza: "/oqituvchi-kabineti/oraliq-nazorat",
  oraliq: "/oqituvchi-kabineti/oraliq-nazorat",
  mustaqil: "/oqituvchi-kabineti/oraliq-nazorat",
  yakuniy: "/oqituvchi-kabineti/yakuniy-nazorat",
  umumiy: "/oqituvchi-kabineti/natijalar",
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1))

/** O'qituvchining o'z fanlaridagi haqiqiy sonlar (ko'pi bilan 5 ta fan-guruh) */
async function ownNumbers(teacherId: number, topic: GradeTopic): Promise<string> {
  const mine = await listTeacherContent({ teacherUserId: teacherId })
  const pairs = new Map<string, { groupId: number; subjectName: string }>()
  for (const c of mine) if (c.groupId != null) pairs.set(`${c.groupId}|${c.subjectName}`, { groupId: c.groupId, subjectName: c.subjectName })
  if (!pairs.size) return ""
  const groupIds = [...new Set([...pairs.values()].map((p) => p.groupId))]
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id, name FROM lms_groups WHERE id IN (?)", [groupIds])
  const names = new Map(rows.map((r) => [Number(r.id), String(r.name)]))

  const lines: string[] = []
  for (const pair of [...pairs.values()].slice(0, 5)) {
    // Talabalar ro'yxatisiz — faqat tuzilma (mavzular, ulushlar, shkala)
    const j = await buildGradeJournal(pair.groupId, pair.subjectName, [])
    const name = `${names.get(pair.groupId) ?? `guruh #${pair.groupId}`} · ${pair.subjectName}`
    const s = j.scale
    const practiceMi = j.miColumns.filter((m) => m.part === "Amaliyot").reduce((sum, m) => sum + m.points, 0)
    const lectureMi = j.miColumns.filter((m) => m.part !== "Amaliyot").reduce((sum, m) => sum + m.points, 0)
    if (topic === "amaliyot") {
      lines.push(j.topics.length
        ? `• ${name}: amaliy topshiriqlar ${j.topics.length} ta, JN ${fmt(s.jn)} ball${practiceMi ? ` (mustaqil ishga ${fmt(practiceMi)} ball ketgan)` : ""} — har bir topshiriq ${fmt(j.topics[0].points)} ball.`
        : `• ${name}: amaliy mavzularda hali baholanadigan topshiriq yoki test yo'q — JN (${fmt(s.jn)} ball) hech kimga yozilmaydi.`)
    } else if (topic === "oraliq" || topic === "maruza") {
      const on = (key: "ON1" | "ON2", pts: number) => `${key} — ${fmt(pts)} ball${j.periodItems[key] ? "" : " (hali yaratilmagan)"}`
      lines.push(`• ${name}: ${on("ON1", s.on1)}, ${on("ON2", s.on2)}${lectureMi ? `, ma'ruzadan mustaqil ish — ${fmt(lectureMi)} ball` : ""}.`)
    } else if (topic === "mustaqil") {
      lines.push(j.miColumns.length
        ? `• ${name}: ${j.miColumns.map((m) => `${m.label} (${m.part}) — ${fmt(m.points)} ball`).join(", ")}.`
        : `• ${name}: mustaqil ish yaratilmagan.`)
    } else if (topic === "yakuniy") {
      lines.push(`• ${name}: yakuniy nazorat ${j.periodItems.YN ? "yaratilgan" : "hali yaratilmagan"} — ${fmt(s.yn)} ball.`)
    } else {
      lines.push(`• ${name}: Ma'ruza 35 = ON1 ${fmt(s.on1)} + ON2 ${fmt(s.on2)}${lectureMi ? ` + MI ${fmt(lectureMi)}` : ""}; Amaliyot 35 = JN ${fmt(s.jn)}${practiceMi ? ` + MI ${fmt(practiceMi)}` : ""} (${j.topics.length} ta amaliy topshiriq); Yakuniy ${fmt(s.yn)}.`)
    }
    if (j.untypedTopicCount > 0 && topic === "amaliyot") {
      lines.push(`  ⚠ ${j.untypedTopicCount} ta mavzuning turi (Ma'ruza/Amaliyot) belgilanmagan — ular JN'ga kirmayapti.`)
    }
  }
  if (!lines.length) return ""
  const more = pairs.size > 5 ? `\n(Yana ${pairs.size - 5} ta fan-guruhingiz bor.)` : ""
  return `\n\nSizning fanlaringizda hozir:\n${lines.join("\n")}${more}`
}

/* ── "Qanday qilinadi" — eng ko'p so'raladigan ishlar bo'yicha aniq qo'llanma ──
 * Model bu savollarga to'qib javob bergan ("Fan imtihonlari → Yangi imtihon" degan
 * mavjud bo'lmagan yo'l, 2026-11-12). Tugma va bo'lim nomlari saytdagi bilan bir xil;
 * sahifa o'zgarsa shu yerni yangilang. */
interface HowTo { match: RegExp; page: string; text: string }

const HOWTOS: HowTo[] = [
  {
    match: /^(?=.*test)(?=.*(yarat|tuz|qo'sh|yukla|kirit|joyla))/,
    page: "/oqituvchi-kabineti/fan-resurslari",
    text: [
      "Mavzuga test qo'shish — «Mavzu va resurslar» sahifasida:",
      "1) Guruh va fanni tanlang, kerakli mavzuni oching (mavzu yo'q bo'lsa avval \"Yangi mavzu\" bilan yarating).",
      "2) Mavzu ichida Test bo'limini oching.",
      "3) Savollarni ikki usuldan biri bilan kiriting: qo'lda bittalab, yoki tayyor .txt faylni shu bo'limga sudrab tashlang — savollar o'zi yuklanadi.",
      "4) .txt fayl ko'rinishi: \"1. Savol matni\", tagida variantlar — to'g'risi oldiga \"+\", noto'g'rilari oldiga \"-\". Fayl boshida ixtiyoriy sozlamalar: \"ball: 100\", \"vaqt: 15\", \"urinish: 2\", \"test soni: 10\".",
      "5) Vaqt, urinishlar soni, ko'rsatiladigan savollar soni va muddatni belgilab, saqlang.",
      "Eslatma: talaba testdan 60% olsa o'tgan hisoblanadi va keyingi bo'lim ochiladi. Savoli yo'q test talabalarga ko'rinmaydi.",
      "Oraliq yoki yakuniy nazorat testi boshqa joyda — «Imtihonlar ro'yxati» sahifasida yaratiladi.",
      "Menga \"shu mavzudan 10 ta test tuzib ber\" desangiz, tayyor .txt fayl qilib beraman.",
    ].join("\n"),
  },
  {
    match: /^(?=.*(topshiri|vazifa))(?!.*(bahola|tekshir))(?=.*(ber|yarat|qo'sh|yukla|joyla))/,
    page: "/oqituvchi-kabineti/fan-resurslari",
    text: [
      "Talabalarga topshiriq berish — «Mavzu va resurslar» sahifasida:",
      "1) Guruh va fanni tanlang, kerakli amaliy mavzuni oching.",
      "2) Mavzu ichida Topshiriq bo'limini oching.",
      "3) Sarlavha, topshiriq sharti (tavsif), muddat va maksimal ballni kiriting; kerak bo'lsa namuna fayl biriktiring.",
      "4) Saqlang — talabalar mavzuda topshiriqni ko'radi va javob faylini yuklaydi.",
      "5) Topshirilgan ishlarni «Baholash» sahifasida ochib baholaysiz.",
      "Eslatma: talaba fayl yuklashi bilan keyingi mavzu ochiladi (baholanishini kutmaydi). Muddat o'tgach yuklay olmaydi — muddatni uzaytirish yoki mavzuni qayta ochish kerak.",
      "Menga \"shu mavzudan topshiriq yaratib ber\" desangiz, PDF qilib tayyorlab beraman.",
    ].join("\n"),
  },
  {
    match: /^(?=.*mavzu)(?!.*(video|audio|taqdimot|prezentatsiya|qo'llanma|test|topshiri|fayl))(?=.*(yarat|qo'sh))/,
    page: "/oqituvchi-kabineti/fan-resurslari",
    text: [
      "Yangi mavzu yaratish — «Mavzu va resurslar» sahifasida:",
      "1) Guruh va fanni tanlang.",
      "2) \"Yangi mavzu\" tugmasini bosing, mavzu nomini yozing.",
      "3) Turini tanlang: Ma'ruza yoki Amaliyot. Bu muhim: JN (joriy nazorat) faqat Amaliyot mavzularidan hisoblanadi, turi belgilanmagan mavzu jurnalga kirmaydi.",
      "4) Saqlang va mavzuni ochib, bo'limlariga material qo'shing: Video, Audio, Taqdimot, Qo'llanma, Test, Topshiriq.",
      "5) Tayyor mavzuni \"Boshqa guruhlarga tarqatish\" orqali boshqa guruhlaringizga ham nusxalash mumkin.",
    ].join("\n"),
  },
  {
    match: /^(?=.*(video|audio|taqdimot|prezentatsiya|qo'llanma|material|fayl|resurs))(?=.*(yukla|qo'sh|joyla))/,
    page: "/oqituvchi-kabineti/fan-resurslari",
    text: [
      "Material yuklash — «Mavzu va resurslar» sahifasida:",
      "1) Guruh va fanni tanlang, mavzuni oching.",
      "2) Kerakli bo'limni tanlang va faylni yuklang (yoki sudrab tashlang):",
      "   • Video — faqat video fayl (mp4). Telefonlarda ochilishi uchun tizim uni fonda o'zi moslaydi.",
      "   • Audio — mp3.",
      "   • Taqdimot va Qo'llanma — PDF, PowerPoint yoki Word.",
      "3) Har bo'limga o'z turidagi faylni qo'ying. Masalan Video bo'limiga taqdimot yuklansa, talaba uni \"ko'rib tugata\" olmaydi va keyingi bo'limlar ochilmay qoladi.",
      "Talaba tartibi: Video → Audio → Taqdimot → Qo'llanma → Test → Topshiriq. Oldingisini tugatmaguncha keyingisi ochilmaydi; video oxirigacha ko'rilishi, taqdimotning hamma sahifasi o'qilishi kerak.",
    ].join("\n"),
  },
  {
    match: /muddat\w*.*(uzaytir|o'zgartir|o'tib|o'tgan|tugagan)|deadline|(qayta och|qaytadan och)\w*/,
    page: "/oqituvchi-kabineti/fan-resurslari",
    text: [
      "Muddati o'tgan test yoki topshiriq bo'lsa, talaba endi topshira olmaydi va keyingi mavzuga o'tmaydi. Ikki yo'l bor:",
      "1) Muddatni uzaytirish: «Mavzu va resurslar» sahifasida mavzuni oching, test yoki topshiriqni tahrirlab, yangi muddat qo'ying.",
      "2) Mavzuni qayta ochish: mavzu kartasida qayta topshirishga ruxsat bering — muddat o'tgan bo'lsa ham talabalar topshira oladi.",
      "Faqat bitta talabaga imkon berish kerak bo'lsa — unga qo'shimcha urinish (qayta urinish) beriladi; buni hal qila olmasangiz, adminga murojaat qiling.",
      "Qaysi mavzularda muddat o'tganini men tekshirib bera olaman: \"nega talabalar o'ta olmayapti\" deb so'rang.",
    ].join("\n"),
  },
  {
    match: /(qayta urinish|qo'shimcha urinish|yana urinish|urinish\w* (ber|qo'sh|tugagan|qolmagan))/,
    page: "/oqituvchi-kabineti/natijalar",
    text: [
      "Talaba testdan o'ta olmay, urinishlari tugagan bo'lsa, keyingi mavzuga o'ta olmaydi. Unga qo'shimcha urinish beriladi:",
      "1) O'qituvchi sifatida: test natijalari ro'yxatida shu talaba qatoridan qayta urinishga ruxsat bering.",
      "2) Oraliq va yakuniy nazorat uchun qayta urinishni admin beradi (Admin panel → Qayta urinish).",
      "Ruxsat bir martalik: talaba topshirgach sarflanadi. Jurnalga eng yuqori natija yoziladi.",
    ].join("\n"),
  },
]

/** "Qanday qilinadi" savoliga tayyor qo'llanma (bo'lsa) */
export function howToAnswer(text: string): { reply: string; page: string } | null {
  const t = norm(text)
  // Faqat savol yoki niyat bo'lsa ("qanday", "qayerda", "...moqchiman", "kerak") — "test tuzib ber" bu emas
  if (!/(qanday|qanaqa|qayer|moqchi|kerak|bo'ladimi|mumkinmi|nima qil|tushuntir|o'rgat)/.test(t)) return null
  if (/(tuz|yarat|yoz|tayyorla)(ib)?\s*ber/.test(t)) return null
  const hit = HOWTOS.find((h) => h.match.test(t))
  return hit ? { reply: hit.text, page: hit.page } : null
}

/** Shu mavzu hozirgina to'liq tushuntirilgan bo'lsa — davom savoliga qisqa, aniq javob */
const SHORT: Partial<Record<GradeTopic, string>> = {
  amaliyot: "Qisqasi: har bir amaliy topshiriqni uni yaratishda o'zingiz belgilagan maksimal balldan baholaysiz (odatda 100 balldan); test avtomatik 100 ballikda baholanadi. Jurnal natijani foizga aylantirib, topshiriqning JN'dagi ulushiga ko'paytiradi. Butun amaliyot qismi — 35 ball.",
  oraliq: "Qisqasi: oraliq test bo'lsa talaba 100 ballikda topshiradi va foizi siz ajratgan ballga aylanadi; topshiriq bo'lsa uni ajratgan balingizdan baholaysiz. Ikkala oraliq va ma'ruzadan mustaqil ishlar birga 35 balldan oshmaydi.",
  maruza: "Qisqasi: ma'ruza qismi 35 ball — uni ON1, ON2 va ma'ruzadan mustaqil ishlar o'rtasida o'zingiz taqsimlaysiz. Ma'ruza mavzularidagi testlar ball bermaydi.",
  mustaqil: "Qisqasi: mustaqil ishga ballni yaratishda o'zingiz belgilaysiz; u Ma'ruza yoki Amaliyotning 35 balidan olinadi. Test 100 ballikda topshirilib foizi shu ballga aylanadi, topshiriq esa shu balldan baholanadi.",
  yakuniy: "Qisqasi: yakuniy nazorat 30 ball; test 100 ballikda topshiriladi va foizi 30 ballga aylanadi.",
}

/** Oldingi javob shu mavzuning to'liq tushuntirishi edimi */
export function alreadyExplained(topic: GradeTopic, lastAssistantText: string | undefined): boolean {
  return !!lastAssistantText && lastAssistantText.startsWith(RULES[topic].split("\n")[0])
}

export async function gradingAnswer(topic: GradeTopic, teacherId: number | undefined, brief = false): Promise<{ reply: string; page: string }> {
  let own = ""
  if (teacherId) {
    try { own = await ownNumbers(teacherId, topic) } catch { /* sonlarsiz ham qoida aytiladi */ }
  }
  const body = brief && SHORT[topic] ? SHORT[topic]! : RULES[topic]
  return { reply: `${body}${own}`, page: PAGE[topic] }
}
