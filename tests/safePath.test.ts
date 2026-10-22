import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import os from "os"
import path from "path"
import { isSafeFileName, resolveInside, existingFileInside, escapeLike } from "../src/services/safePath"
import { sanitizeFilename } from "../src/services/teachingStore"

const ALLOWED = [
  "1734567890123-0123456789abcdef.pdf",
  "Lab..1-1700000000000-ab12cd34.docx",
  "_photo-1700000000000-ab12cd34.png",
  "template-1700000000000.png",
]

const BLOCKED: unknown[] = [
  "", ".", "..", ".env", ".hidden.png",
  "../etc/passwd", "..\\..\\windows\\win.ini", "a/b.png", "a\\b.png",
  "/etc/passwd", "C:\\boot.ini", "C:boot.ini", "file:x.png",
  "%2e%2e%2fetc%2fpasswd", "..%2F.env", "a%00.png", "a\u0000.png",
  "-rf", "name with space.png", "имя.png", "a".repeat(201),
  null, undefined, 1, ["a.png"], { toString: () => "a.png" },
]

test("isSafeFileName: server yaratgan nomlar o'tadi", () => {
  for (const name of ALLOWED) assert.equal(isSafeFileName(name), true, name)
})

test("isSafeFileName: traversal, mutlaq yo'l, kodlangan va g'alati qiymatlar rad etiladi", () => {
  for (const name of BLOCKED) assert.equal(isSafeFileName(name), false, String(name))
})

test("resolveInside: natija har doim root'ning bevosita ichida, aks holda null", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lms-root-"))
  for (const name of ALLOWED) {
    const full = resolveInside(root, name)
    assert.ok(full, name)
    assert.equal(path.dirname(full!), path.resolve(root))
  }
  for (const name of BLOCKED) assert.equal(resolveInside(root, name), null, String(name))
})

test("existingFileInside: faqat root ichidagi mavjud oddiy fayl", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lms-parent-"))
  const root = path.join(parent, "root")
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(root, "ok.png"), "x")
  fs.mkdirSync(path.join(root, "dir.png"))
  fs.writeFileSync(path.join(parent, "secret.txt"), "maxfiy")

  assert.equal(await existingFileInside(root, "ok.png"), fs.realpathSync(path.join(root, "ok.png")))
  assert.equal(await existingFileInside(root, "missing.png"), null)
  assert.equal(await existingFileInside(root, "dir.png"), null, "papka fayl sifatida qaytmasin")
  assert.equal(await existingFileInside(root, "../secret.txt"), null)
  assert.equal(await existingFileInside(path.join(root, "nope"), "ok.png"), null)

  // Symlink orqali tashqariga chiqish (Windows'da huquq bo'lmasa — o'tkazib yuboriladi)
  let linked = false
  try { fs.symlinkSync(path.join(parent, "secret.txt"), path.join(root, "link.txt")); linked = true } catch { /* EPERM */ }
  if (linked) assert.equal(await existingFileInside(root, "link.txt"), null, "symlink root'dan chiqmasin")
})

test("sanitizeFilename: natija har doim xavfsiz nom (yuklashda 400 bo'lib qolmaydi)", () => {
  const inputs = ["../../etc/passwd", "..\\..\\x.pdf", ".env", "..png", "-rf.docx", "Лаб иш №1.docx", "a b c.PDF", "", "....", "%2e%2e%2f.png", "x\u0000y.pdf"]
  for (const input of inputs) {
    const name = sanitizeFilename(input)
    assert.equal(isSafeFileName(name), true, `${JSON.stringify(input)} → ${name}`)
  }
})

test("escapeLike: LIKE maxsus belgilari ekranlanadi", () => {
  assert.equal(escapeLike("a_b%c\\d"), "a\\_b\\%c\\\\d")
  assert.equal(escapeLike("plain-1.png"), "plain-1.png")
})
