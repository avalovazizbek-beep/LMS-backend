/**
 * HEMIS'ning o'zidan (mahalliy sinxronlangan nusxadan emas) to'g'ridan-to'g'ri
 * so'raydi: Masofaviy ta'lim (_education_form=16) bo'yicha har bir kurs
 * (_level=11..14) uchun nechta FAOL talaba bor — 3/4-kurs haqiqatan
 * HEMIS'da yo'qmi yoki faqat bizning sinxronizatsiyamizda yo'qolib
 * qolganmi, shuni aniqlash uchun. Faqat pagination.totalCount o'qiladi
 * (limit=1) — talabalar ro'yxatining o'zi kerak emas, sanog'i yetarli.
 *
 * Ishga tushirish:
 *   npx ts-node scripts/check-hemis-levels.ts
 */
import "dotenv/config"
import axios from "axios"

function normalizeRestBase(base: string) {
  return base.replace(/\/+$/, "")
}

const HEMIS_BASE = normalizeRestBase(process.env.HEMIS_BASE || process.env.HEMIS_STUDENT_URL || "https://student.sies.uz/rest")
const HEMIS_TOKEN = process.env.HEMIS_TOKEN || ""

const EDUCATION_FORM_MASOFAVIY = "16"
const LEVELS = [
  { code: "11", label: "1-kurs" },
  { code: "12", label: "2-kurs" },
  { code: "13", label: "3-kurs" },
  { code: "14", label: "4-kurs" },
]

async function countFor(levelCode: string): Promise<number | string> {
  const url = new URL(`${HEMIS_BASE}/v1/data/student-list`)
  url.searchParams.set("_education_form", EDUCATION_FORM_MASOFAVIY)
  url.searchParams.set("_level", levelCode)
  url.searchParams.set("limit", "1")
  try {
    const { data } = await axios.get(url.toString(), {
      headers: { Authorization: `Bearer ${HEMIS_TOKEN}`, Accept: "application/json" },
      timeout: 20000,
    })
    const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>
    const inner = (record.data && typeof record.data === "object" ? record.data : record) as Record<string, unknown>
    const pagination = (inner.pagination && typeof inner.pagination === "object" ? inner.pagination : {}) as Record<string, unknown>
    return Number(pagination.totalCount ?? pagination.total_count ?? pagination.total ?? -1)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

async function main() {
  if (!HEMIS_TOKEN) {
    console.error("HEMIS_TOKEN .env da sozlanmagan — davom etib bo'lmaydi.")
    process.exit(1)
  }
  console.log(`HEMIS_BASE = ${HEMIS_BASE}\n`)
  const rows: { kurs: string; level_code: string; hemisdagi_soni: number | string }[] = []
  for (const level of LEVELS) {
    const count = await countFor(level.code)
    rows.push({ kurs: level.label, level_code: level.code, hemisdagi_soni: count })
    // HEMIS admin-token /v1/data/* limiti past — so'rovlar orasida biroz kutamiz
    await new Promise(r => setTimeout(r, 1500))
  }
  console.log("Masofaviy ta'lim (_education_form=16) — HEMIS'ning o'zidagi FAOL talabalar soni, kurs bo'yicha:\n")
  console.table(rows)
}

main().catch(err => { console.error(err); process.exit(1) })
