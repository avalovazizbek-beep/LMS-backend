/* ── O'qituvchi yordamchisi (AI agent) uchun sayt qo'llanmasi ───────────
 * Model saytni faqat shu matndan biladi. Sahifa qo'shilsa yoki ish tartibi
 * o'zgarsa — shu yerni yangilang (yangi sahifa: PAGES'ga bitta yozuv).
 * `path` — frontenddagi haqiqiy manzil: model faqat shu ro'yxatdagi
 * sahifalarni ochishni taklif qila oladi (routes/assistant.ts tekshiradi). */

export interface GuidePage {
  path: string
  title: string
  /** Faqat admin huquqi bor foydalanuvchiga taklif qilinadi / ochiladi */
  adminOnly?: boolean
  /** Yon menyudagi bo'lim */
  menu: string
  /** Savolda uchrasa shu sahifa nazarda tutiladigan so'z o'zaklari (kichik harfda) */
  keywords?: string[]
  /** Sahifa nima uchun */
  purpose: string
  /** Qadamma-qadam: asosiy ish qanday bajariladi */
  steps?: string[]
}

export const TEACHER_PAGES: GuidePage[] = [
  {
    path: "/dashboard", keywords: ["bosh sahifa","boshqaruv paneli"], title: "Boshqaruv paneli", menu: "Bosh sahifa",
    purpose: "O'qituvchining bosh sahifasi: bugungi darslar va tezkor havolalar.",
  },
  {
    path: "/oqituvchi-kabineti/fan-resurslari", keywords: ["mavzu","resurs","video","audio","taqdimot","material","test yukla","test qo'sh","topshiriq ber","topshiriq yarat","topshiriq qo'sh","dars yukla","muddat","deadline"], title: "Mavzu va resurslar (Fan resurslari)", menu: "Fanlar bazasi",
    purpose: "Fan mavzularini yaratish va har bir mavzuga material qo'shish: video, audio, taqdimot, hujjat, test, topshiriq, meeting havolasi. Talabalar ko'radigan hamma kontent shu yerda tayyorlanadi.",
    steps: [
      "Guruh va fanni tanlang.",
      "\"Yangi mavzu\" tugmasini bosing, mavzu nomini yozing va turini tanlang: Ma'ruza yoki Amaliyot.",
      "Mavzuni oching va kerakli bo'limga material qo'shing: Video, Audio, Taqdimot, Test yoki Topshiriq.",
      "Test uchun: savollarni qo'lda kiriting yoki tayyor .txt faylni Test bo'limiga sudrab tashlang (savollar o'zi yuklanadi). Vaqt, urinishlar soni va muddatni belgilang.",
      "Topshiriq uchun: sarlavha, tavsif, muddat (deadline) va maksimal ballni kiriting; kerak bo'lsa namuna fayl biriktiring.",
      "Tayyor mavzuni boshqa guruhlarga ham tarqatish mumkin (\"Boshqa guruhlarga tarqatish\").",
      "Muddat o'tib ketgan bo'lsa: muddatni uzaytiring yoki talabaga qayta topshirishga ruxsat bering.",
    ],
  },
  {
    path: "/oqituvchi-kabineti/baholash-page", keywords: ["bahola","baho qo'y","tekshir","topshirgan","topshirilgan ish","ball qo'y"], title: "Baholash", menu: "Fanlar bazasi",
    purpose: "Talabalar topshirgan ishlarni (topshiriq fayllarini) tekshirish va baho qo'yish. Tepada nechta ish baholash kutayotgani ko'rinadi.",
    steps: [
      "Guruh va fanni tanlang — baholash kutayotgan ishlar ro'yxati chiqadi.",
      "Talabaning ishini oching: yuklagan faylini ko'ring yoki yuklab oling.",
      "Ballni kiriting (topshiriqning maksimal balidan oshmasin), kerak bo'lsa izoh yozing va saqlang.",
      "Baho talabaga darhol ko'rinadi va natijalar jurnaliga tushadi.",
      "Test ballari avtomatik qo'yiladi — ularni qo'lda baholash shart emas.",
    ],
  },
  {
    path: "/oqituvchi-kabineti/natijalar", keywords: ["natija","jurnal","ballar","o'zlashtirish","excel"], title: "Mavzular bo'yicha natijalar", menu: "Fanlar bazasi",
    purpose: "Talabalarning mavzular bo'yicha test ballari, davomati va umumiy ballar jurnali.",
    steps: [
      "Guruh va fanni tanlang.",
      "Jurnalda: Ma'ruza = ON1 + ON2 + mustaqil ishlar; Amaliyot = JN (amaliy topshiriqlar) + mustaqil ishlar; Joriy = Ma'ruza + Amaliyot.",
      "ON yoki YN katakchasini bosing, sonni kiriting va Enter bosing — baho saqlanadi.",
      "Talaba ismini bossangiz, uning batafsil baholari ochiladi.",
      "Jurnalni Excel fayl qilib yuklab olish mumkin.",
    ],
  },
  {
    path: "/oqituvchi-kabineti/oraliq-nazorat", keywords: ["oraliq","mustaqil ish","1-on","2-on","on1","on2"], title: "Imtihonlar ro'yxati (oraliq nazorat va mustaqil ish)", menu: "O'quv jarayoni",
    purpose: "Oraliq nazorat (ON1, ON2) va mustaqil ish uchun test yoki topshiriq yaratish, natijalarini ko'rish.",
    steps: [
      "\"Yangi qo'shish\" tugmasini bosing.",
      "\"HEMIS'dagi nazoratlar\" ro'yxatidan kerakli nazoratni tanlang (1-on yoki 2-on) — guruh, fan, sana va vaqt o'zi to'ldiriladi.",
      "Turini tanlang: test yoki topshiriq. Test bo'lsa savollarni kiriting, vaqt va urinishlar sonini belgilang.",
      "Ballni belgilang va saqlang. Oraliq testda talaba Face ID tekshiruvidan o'tadi.",
      "Muddat o'tib, natijalar bor bo'lsa nazoratni o'chirib bo'lmaydi.",
    ],
  },
  {
    path: "/oqituvchi-kabineti/yakuniy-nazorat", keywords: ["yakuniy"], title: "Yakuniy nazorat", menu: "O'quv jarayoni",
    purpose: "Yakuniy nazorat (YN) uchun test yoki topshiriq yaratish va natijalarini ko'rish.",
  },
  {
    path: "/oqituvchi-kabineti/imtihonlar", keywords: ["fan imtihon","imtihonlar"], title: "Fan imtihonlari", menu: "O'quv jarayoni",
    purpose: "Fan bo'yicha yaratilgan barcha imtihon va testlar ro'yxati, ularni tahrirlash va natijalarini ko'rish.",
  },
  {
    path: "/xodim/qayta-oqish", keywords: ["qayta o'qish"], title: "Qayta o'qish ro'yxati", menu: "Qayta o'qish",
    purpose: "Qayta o'qishga yozilgan talabalar ro'yxati va ularning mashg'ulotlari.",
  },
  {
    path: "/xodim/dars-jadvali", keywords: ["dars jadval","jadval"], title: "Dars jadvali", menu: "Mashg'ulotlar",
    purpose: "O'qituvchining HEMIS'dan olingan haftalik dars jadvali.",
  },
  {
    path: "/xodim/dars-otish", keywords: ["dars o'tish","darsni boshla"], title: "Dars o'tish", menu: "Mashg'ulotlar",
    purpose: "O'tiladigan darslar ro'yxati; darsni boshlash va o'tilgan deb belgilash.",
  },
  {
    path: "/xodim/davomat-jurnali", keywords: ["davomat","davomat jurnal","yo'qlama","keldi-kelmadi"], title: "Davomat jurnali", menu: "Mashg'ulotlar",
    purpose: "Talabalar davomatini belgilash va ko'rish.",
    steps: [
      "Guruh va fanni tanlang.",
      "Avval mashg'ulot turini tanlang: ma'ruza va amaliy uchun davomat alohida olinadi.",
      "Sanani tanlang, har bir talabani \"keldi\" yoki \"kelmadi\" deb belgilang va saqlang.",
      "Saqlangandan keyin davomat qulflanadi. O'zgartirish kerak bo'lsa tahrirlash so'rovi yuboring — admin tasdiqlagach bir marta o'zgartirish mumkin.",
    ],
  },
  {
    path: "/xodim/oraliq-nazorat", title: "Oraliq nazorat (HEMIS)", menu: "Nazoratlar",
    purpose: "HEMIS'da belgilangan oraliq nazoratlar jadvali (faqat ko'rish). Test yoki topshiriq yaratish — \"Imtihonlar ro'yxati\" sahifasida.",
  },
  {
    path: "/xodim/yakuniy-nazorat", title: "Yakuniy nazorat (HEMIS)", menu: "Nazoratlar",
    purpose: "HEMIS'da belgilangan yakuniy nazoratlar jadvali (faqat ko'rish).",
  },
  {
    path: "/xodim/boshqa-nazoratlar", keywords: ["boshqa nazorat"], title: "Boshqa nazoratlar (HEMIS)", menu: "Nazoratlar",
    purpose: "HEMIS'dagi boshqa turdagi nazoratlar ro'yxati (faqat ko'rish).",
  },
  {
    path: "/meeting", keywords: ["meeting","miting","onlayn dars","online dars","zoom","google meet","video uchrashuv","konferens"], title: "Meeting (onlayn dars)", menu: "Meeting",
    purpose: "Onlayn dars (video uchrashuv) yaratish va o'tkazish, yozuvlarini ko'rish.",
    steps: [
      "\"Yangi meeting yaratish\" tugmasini bosing, nom, vaqt va guruhlarni tanlang — meeting faqat tanlangan guruhlarga ko'rinadi.",
      "Zoom yoki Google Meet orqali o'tkazmoqchi bo'lsangiz, avval Tizim → Profil sahifasida akkauntingizni ulang.",
      "Vaqti kelganda meetingga kiring. Dars paytida ishtirokchilar va ularning kameralarini ko'rasiz.",
    ],
  },
  {
    path: "/oqituvchi-kabineti/murojaatlar", keywords: ["murojaat"], title: "Murojaatlar", menu: "Murojaatlar",
    purpose: "Talabalardan kelgan murojaatlarni o'qish va javob yozish.",
  },
  {
    path: "/tizim/profil", keywords: ["profil","akkaunt"], title: "Profil", menu: "Tizim",
    purpose: "Shaxsiy ma'lumotlar, Zoom va Google akkauntini ulash.",
  },
  {
    path: "/yoriqnoma", keywords: ["yo'riqnoma","qo'llanma","video darslik"], title: "Yo'riqnoma", menu: "Yo'riqnoma",
    purpose: "Tizimdan foydalanish bo'yicha video darsliklar va materiallar.",
  },

  // ── Admin panel (faqat admin huquqi bor foydalanuvchiga taklif qilinadi) ──
  {
    path: "/admin/dashboard", adminOnly: true, keywords: ["admin panel", "admin", "boshqaruv panel admin"], title: "Admin panel", menu: "Admin panel",
    purpose: "Admin boshqaruv paneli: umumiy statistika va barcha admin bo'limlari.",
  },
  {
    path: "/admin/foydalanuvchilar", adminOnly: true, keywords: ["foydalanuvchilar", "admin foydalanuvchi", "rol ber"], title: "Foydalanuvchilar (admin)", menu: "Admin panel",
    purpose: "Foydalanuvchilar ro'yxati va ularga rol berish.",
  },
  {
    path: "/admin/talabalar", adminOnly: true, keywords: ["talabalar ro'yxati", "chetlatilgan", "maxsus ehtiyoj", "admin talaba"], title: "Talabalar ro'yxati (admin)", menu: "Admin panel",
    purpose: "Guruhlar bo'yicha talabalar, Face ID holati, chetlatilgan va maxsus ehtiyojli talabalar.",
  },
  {
    path: "/admin/oqituvchilar", adminOnly: true, keywords: ["o'qituvchi hisobot", "o'qituvchilar hisobot", "admin o'qituvchi"], title: "O'qituvchi hisoboti (admin)", menu: "Admin panel",
    purpose: "O'qituvchilar faoliyati hisoboti: yuklangan mavzular va materiallar.",
  },
  {
    path: "/admin/hisobot", adminOnly: true, keywords: ["natijalar jurnali", "admin hisobot", "admin natija"], title: "Natijalar jurnali (admin)", menu: "Admin panel",
    purpose: "Barcha guruhlar bo'yicha natijalar jurnali.",
  },
  {
    path: "/admin/davomatlar", adminOnly: true, keywords: ["admin davomat", "davomatlar", "davomat so'rov", "tahrirlash so'rov"], title: "Davomatlar (admin)", menu: "Admin panel",
    purpose: "Barcha guruhlar davomati va o'qituvchilarning davomatni tahrirlash so'rovlarini tasdiqlash.",
  },
  {
    path: "/admin/baholash", adminOnly: true, keywords: ["admin bahola", "baholashlar"], title: "Baholashlar (admin)", menu: "Admin panel",
    purpose: "Barcha o'qituvchilarning baholash holati.",
  },
  {
    path: "/admin/qayta-urinish", adminOnly: true, keywords: ["qayta urinish", "urinish ber", "muddatni uzaytir"], title: "Qayta urinish (admin)", menu: "Admin panel",
    purpose: "Talabaga testga qo'shimcha urinish berish va mavzu muddatlarini o'zgartirish.",
  },
  {
    path: "/admin/oraliqlar", adminOnly: true, keywords: ["oraliqlar", "admin oraliq"], title: "Oraliqlar (admin)", menu: "Admin panel",
    purpose: "Barcha oraliq nazorat va mustaqil ishlar ro'yxati.",
  },
  {
    path: "/admin/face-id", adminOnly: true, keywords: ["face id so'rov", "face id", "yuz so'rov"], title: "Face ID so'rovlari (admin)", menu: "Admin panel",
    purpose: "Talabalarning Face ID'ni qayta ro'yxatdan o'tkazish so'rovlari.",
  },
  {
    path: "/admin/elonlar", adminOnly: true, keywords: ["e'lon", "elon"], title: "E'lonlar (admin)", menu: "Admin panel",
    purpose: "Talaba va xodimlarga e'lon yaratish.",
  },
  {
    path: "/admin/ruxsatlar", adminOnly: true, keywords: ["ruxsatlar", "ruxsat boshqaruv"], title: "Ruxsatlar boshqaruvi (admin)", menu: "Admin panel",
    purpose: "Rollar bo'yicha ruxsatlarni sozlash.",
  },
  {
    path: "/admin/tashakkurnomalar", adminOnly: true, keywords: ["tashakkurnoma", "sertifikat"], title: "Tashakkurnomalar (admin)", menu: "Admin panel",
    purpose: "O'qituvchilarga berilgan tashakkurnomalar.",
  },
  {
    path: "/admin/sozlamalar", adminOnly: true, keywords: ["sozlamalar", "sozlama", "telegram"], title: "Sozlamalar (admin)", menu: "Admin panel",
    purpose: "Tizim sozlamalari: Face ID chegarasi, urinishlar soni, Telegram va boshqalar.",
  },
]

const GENERAL_RULES = [
  "LMS — Samarqand iqtisodiyot va servis instituti (SamISI) masofaviy ta'lim tizimi. Guruhlar va dars jadvali HEMIS'dan olinadi; mavzular, materiallar, testlar, topshiriqlar va baholar LMS'ning o'zida saqlanadi.",
  "Baholash tizimi: Joriy nazorat (JN) — amaliy mashg'ulot topshiriqlari; Oraliq nazorat — ON1 va ON2; Mustaqil ish (MI); Yakuniy nazorat (YN). Ma'ruza qismi = ON1 + ON2 + mustaqil ishlar, Amaliyot qismi = JN + mustaqil ishlar.",
  "Ma'ruza mavzusidagi test faqat keyingi mavzuni ochadi (ballga kirmaydi). Talaba keyingi mavzuga o'tishi uchun topshiriqni yuklashi yetarli.",
  "Test va oraliq nazoratda talaba Face ID tekshiruvidan o'tadi; oynadan bir necha marta chiqsa test yakunlanadi.",
  "Talabaga qo'shimcha urinish berish yoki yopilgan mavzuni qayta ochish uchun mavzu sahifasidagi qayta topshirish ruxsatidan foydalaniladi; o'qituvchi hal qila olmasa — adminga murojaat qilinadi.",
]

export const TEACHER_PATHS = TEACHER_PAGES.map((p) => p.path)

/** Model uchun qo'llanma matni */
export function teacherGuideText(): string {
  const pages = TEACHER_PAGES.map((p) => {
    const steps = p.steps?.length ? `\n  Qadamlar:\n${p.steps.map((s, i) => `    ${i + 1}) ${s}`).join("\n")}` : ""
    return `- ${p.title}\n  Manzil: ${p.path}\n  Menyu: ${p.menu}\n  Vazifasi: ${p.purpose}${steps}`
  }).join("\n")
  return `UMUMIY MA'LUMOT:\n${GENERAL_RULES.map((r) => `- ${r}`).join("\n")}\n\nO'QITUVCHI SAHIFALARI:\n${pages}`
}

export function pageTitle(path: string | null): string | null {
  return TEACHER_PAGES.find((p) => p.path === path)?.title ?? null
}
