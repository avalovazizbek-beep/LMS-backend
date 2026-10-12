/* Mashg'ulot turi (ma'ruza, amaliy, ...) — davomat varag'i kalitining bir
   qismi. HEMIS, jurnal va meeting turli yozuvda yuboradi ("Ma’ruza",
   "Amaliy mashg'ulot", "Лекция"), shuning uchun bitta ko'rinishga keltiriladi. */
const TRAINING_TYPE_ALIASES: [RegExp, string][] = [
  [/ma'?ruza|lecture|лекц|маъруза/, "Ma'ruza"],
  [/amaliy|practic|практ|амалий/, "Amaliy"],
  [/laborator|лаборат/, "Laboratoriya"],
  [/seminar|семинар/, "Seminar"],
  [/mustaqil|independent|самостоят|мустақил/, "Mustaqil ta'lim"],
]

/** Bo'sh qator — tur ko'rsatilmagan (eski yozuvlar, turi noma'lum meeting). */
export function normalizeTrainingType(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim() : ""
  if (!text) return ""
  const key = text.toLowerCase().replace(/[‘’ʻʼ`´']/g, "'")
  for (const [pattern, name] of TRAINING_TYPE_ALIASES) {
    if (pattern.test(key)) return name
  }
  return text.slice(0, 60)
}
