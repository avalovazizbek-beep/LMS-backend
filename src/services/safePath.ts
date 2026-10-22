import fs from "fs"
import path from "path"

/* ── Fayl yo'llari xavfsizligi (path traversal) ─────────────────────────
   Diskdagi fayl faqat ruxsat berilgan papkadan olinadi, uch bosqichda:
     1) nom bitta segment: faqat harf, raqam, ".", "_", "-"; birinchi belgi
        harf/raqam/"_" (shu sabab "." / ".." / yashirin fayl bo'la olmaydi),
        uzunlik cheklangan — "/", "\", ":", "%", NUL, mutlaq yo'l va
        kodlangan ketma-ketliklar shu yerdayoq rad etiladi;
     2) yakuniy yo'l kanonik ko'rinishda (path.resolve) aynan shu papkaning
        bevosita ichida;
     3) mavjud fayl uchun — havolalar (symlink) ochilgandan keyin ham
        (realpath) papka ichida va oddiy fayl. */

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/

export function isSafeFileName(name: unknown): name is string {
  return typeof name === "string" && SAFE_NAME.test(name)
}

/** `root` papkasining bevosita ichidagi `name` faylining to'liq yo'li.
    Nom yaroqsiz yoki yo'l papkadan chiqsa — null. */
export function resolveInside(root: string, name: unknown): string | null {
  if (!isSafeFileName(name)) return null
  const base = path.resolve(root)
  const full = path.resolve(base, name)
  return path.dirname(full) === base ? full : null
}

/** Mavjud oddiy faylning haqiqiy (symlink ochilgan) yo'li — faqat u `root`
    ichida bo'lsa. Fayl yo'q, papka bo'lsa yoki tashqariga olib chiqsa — null. */
export async function existingFileInside(root: string, name: unknown): Promise<string | null> {
  const candidate = resolveInside(root, name)
  if (!candidate) return null
  try {
    const [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(candidate)])
    if (!realFile.startsWith(realRoot + path.sep)) return null
    const stat = await fs.promises.stat(realFile)
    return stat.isFile() ? realFile : null
  } catch {
    return null
  }
}

/** SQL LIKE uchun matndagi maxsus belgilarni (%, _, \) ekranlaydi */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
