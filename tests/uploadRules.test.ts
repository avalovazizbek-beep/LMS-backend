import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { maxScoreError, mediaKindFileError } from "../src/routes/teaching"

/* Mavzu resurslari: test/topshiriq maksimal bali 100 dan oshmaydi; Video va
   Audio bo'limiga faqat o'z turidagi fayl (sudrab tashlangan Word video
   sifatida saqlanib qolgan holat bo'lgan). */

test("maksimal ball: 0..100, bo'sh qiymat — o'zgarishsiz", () => {
  for (const ok of [null, undefined, 0, 1, 35, 100]) assert.equal(maxScoreError(ok), null, String(ok))
  for (const bad of [101, 23333, -1, Number.NaN]) assert.match(String(maxScoreError(bad)), /0 dan 100 gacha/, String(bad))
})

test("Video/Audio bo'limi: faqat mos fayl turi", () => {
  assert.equal(mediaKindFileError("video_lesson", "dars.MP4"), null)
  assert.equal(mediaKindFileError("video_lesson", "dars.webm"), null)
  assert.match(String(mediaKindFileError("video_lesson", "1.docx")), /faqat video/)
  assert.match(String(mediaKindFileError("video_lesson", "fayl")), /faqat video/, "kengaytmasiz")
  assert.equal(mediaKindFileError("audio", "ovoz.mp3"), null)
  assert.match(String(mediaKindFileError("audio", "klip.mp4")), /faqat audio/)
  // Boshqa bo'limlar umumiy ro'yxat bilan tekshiriladi
  assert.equal(mediaKindFileError("qollanma", "1.docx"), null)
  assert.equal(mediaKindFileError(null, "1.docx"), null)
})
