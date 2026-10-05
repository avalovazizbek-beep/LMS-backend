/** So'rov tanasidan (req.body) faqat ruxsat etilgan maydonlarni oladi.
 *  `{ ...item, ...req.body }` kabi yozuv id, createdAt va boshqa ichki
 *  maydonlarni ham so'rov orqali o'zgartirishga yo'l qo'yardi (mass assignment). */
export function pickFields<T extends object, K extends keyof T & string>(body: unknown, keys: readonly K[]): Partial<Pick<T, K>> {
  const src = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const out: Partial<Pick<T, K>> = {}
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key] as T[K]
  }
  return out
}
