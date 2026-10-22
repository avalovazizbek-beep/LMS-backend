import { STORAGE, stubDb, PNG_1PX } from "./helpers"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { templatePath, getCustomTemplate, getCertificateConfig } from "../src/services/certificateStore"

/* Tashakkurnoma shabloni: nom lms_settings'dan o'qiladi — bazadagi qiymat
   buzilgan bo'lsa ham papkadan tashqaridagi fayl ochilmasligi kerak. */

const DIR = path.join(STORAGE, "certificates")

function settings(template: string | null) {
  stubDb((sql) => sql.includes("FROM lms_settings")
    ? (template === null ? [] : [{ key_name: "certificate_template", value: template }])
    : undefined)
}

test("templatePath: faqat server yaratgan template-<raqam>.<png|jpg|webp>", () => {
  const ok = templatePath("template-1700000000000.png")
  assert.equal(ok, path.join(path.resolve(DIR), "template-1700000000000.png"))
  for (const bad of ["../../.env", "/etc/passwd", "template-1.svg", "template-1.png/../../x", "template-abc.png", "..\\template-1.png", "template-1.png\u0000.txt", ""]) {
    assert.equal(templatePath(bad), null, bad)
  }
})

test("getCustomTemplate: bazadagi buzilgan nom tashqi faylni ochmaydi", async () => {
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(STORAGE, "package.json"), "{}")
  fs.writeFileSync(path.join(DIR, "template-1700000000000.png"), PNG_1PX)

  for (const bad of ["../package.json", "../../package.json", "/etc/passwd", "template-1700000000000.png/.."]) {
    settings(bad)
    assert.equal(await getCustomTemplate(), null, bad)
    assert.equal((await getCertificateConfig()).hasCustomTemplate, false, bad)
  }

  settings("template-1700000000000.png")
  const t = await getCustomTemplate()
  assert.ok(t)
  assert.equal(t!.mimeType, "image/png")
  assert.equal((await getCertificateConfig()).hasCustomTemplate, true)

  settings(null)
  assert.equal(await getCustomTemplate(), null)
})
