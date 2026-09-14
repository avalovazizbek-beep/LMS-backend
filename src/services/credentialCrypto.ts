import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"

/**
 * HEMIS login/parolni bazada saqlash uchun qaytariladigan shifrlash (AES-256-GCM).
 * bcrypt kabi bir tomonlama hash bu yerda ishlamaydi — keyinchalik parolni
 * HEMIS'ga qayta yuborishimiz (fon rejimida avto-qayta-login) kerak bo'ladi.
 *
 * Kalit .env dagi HEMIS_CREDENTIALS_KEY dan olinadi. Sozlanmagan bo'lsa
 * JWT_SECRET asosida hosil qilinadi (dev uchun qulay, lekin productionda
 * HEMIS_CREDENTIALS_KEY ni alohida o'rnatish tavsiya etiladi).
 */
const SECRET = process.env.HEMIS_CREDENTIALS_KEY || process.env.JWT_SECRET || "insecure-dev-key"
const KEY = scryptSync(SECRET, "hemis-credentials-v1", 32)

export function encryptSecret(plainText: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString("base64")
}

export function decryptSecret(payload: string): string | null {
  try {
    const buf = Buffer.from(payload, "base64")
    const iv = buf.subarray(0, 12)
    const authTag = buf.subarray(12, 28)
    const encrypted = buf.subarray(28)
    const decipher = createDecipheriv("aes-256-gcm", KEY, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}
