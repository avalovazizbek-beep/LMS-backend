import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { gradeBudget, budgetError, journalScale } from "../src/services/periodGrades"
import type { TeacherContentRecord } from "../src/services/teachingStore"

/* Ma'ruza / amaliyot 35 ballik taqsimoti: oraliqlar, mustaqil ishlar,
   eski (ball qo'yilmagan) oraliqlar va jurnal maksimallari. */

let nextId = 1
function item(fields: Partial<TeacherContentRecord>): TeacherContentRecord {
  return {
    id: nextId++, type: "exam", groupId: 1, subjectName: "Fan", topicKey: null, title: "x",
    kind: null, trainingType: null, controlType: null, gradePoints: null, gradePart: null,
    isActive: true, isReopened: false, availableFrom: "2026-10-01T00:00:00.000Z", deadline: null,
    maxScore: null, questionCount: 0,
    ...fields,
  } as TeacherContentRecord
}
const oraliq = (kind: "ON1" | "ON2", gradePoints: number | null, type: "exam" | "assignment" = "exam") =>
  item({ type, controlType: "oraliq", kind, gradePoints })
function mustaqil(gradePoints: number, gradePart: string, type: "exam" | "assignment" = "assignment") {
  const topicKey = `mi-${nextId}`
  return [
    item({ type: "mavzu", kind: "topic", topicKey, trainingType: "Mustaqil ish" }),
    item({ type, topicKey, trainingType: "Mustaqil ish", gradePoints, gradePart }),
  ]
}

test("ON1 10 + ON2 15 → bitta ma'ruza mustaqil ishiga 10 ball qoladi", () => {
  const content = [oraliq("ON1", 10), oraliq("ON2", 15, "assignment")]
  assert.equal(gradeBudget(content).lecture.used, 25)
  const [marker, mi] = mustaqil(10, "Ma'ruza")
  assert.equal(budgetError([...content, marker], mi), null)
  const [, tooMuch] = mustaqil(11, "Ma'ruza")
  assert.match(budgetError([...content, marker], { ...tooMuch, topicKey: marker.topicKey }) ?? "", /10 ball qolgan/)
})

test("ikkita mustaqil ish 5 balldan sig'adi, uchinchisi sig'maydi", () => {
  const base = [oraliq("ON1", 10), oraliq("ON2", 15)]
  const a = mustaqil(5, "Ma'ruza")
  const b = mustaqil(5, "Ma'ruza")
  assert.equal(gradeBudget([...base, ...a, ...b]).lecture.used, 35)
  const [marker, c] = mustaqil(1, "Ma'ruza")
  assert.notEqual(budgetError([...base, ...a, ...b, marker], c), null)
})

test("eski ball qo'yilmagan oraliqlar 17 + 18 — ma'ruzada joy qolmaydi", () => {
  const content = [oraliq("ON1", null), oraliq("ON2", null)]
  assert.equal(gradeBudget(content).lecture.used, 35)
  const scale = journalScale(content)
  assert.deepEqual(scale, { jn: 35, on1: 17, on2: 18, mi: 0, lecture: 35, practice: 35, yn: 30 })
})

test("amaliyot mustaqil ishi JN maksimalini kamaytiradi", () => {
  const content = [oraliq("ON1", 10), oraliq("ON2", 15), ...mustaqil(10, "Ma'ruza"), ...mustaqil(8, "Amaliyot", "exam")]
  const scale = journalScale(content)
  assert.equal(scale.jn, 27)
  assert.equal(scale.mi, 18)
  assert.equal(scale.jn + scale.on1 + scale.on2 + scale.mi, 70)
})

test("yaratilmagan oraliq o'rni ma'ruzaning qolgan balidan oshmaydi", () => {
  const content = [oraliq("ON1", 10), ...mustaqil(10, "Ma'ruza")]
  const scale = journalScale(content)
  assert.equal(scale.on1, 10)
  assert.equal(scale.on2, 15)
})

test("tahrirda o'z eski balli hisobga olinmaydi", () => {
  const on1 = oraliq("ON1", 10)
  const content = [on1, oraliq("ON2", 15)]
  assert.equal(budgetError(content, { ...on1, gradePoints: 20 }), null)
  assert.notEqual(budgetError(content, { ...on1, gradePoints: 21 }), null)
})

test("mustaqil ishlar qism ichida MI-1, MI-2 bo'lib raqamlanadi", async () => {
  const { miColumns } = await import("../src/services/periodGrades")
  const [m1, a] = mustaqil(5, "Ma'ruza")
  const [m2, b] = mustaqil(10, "Ma'ruza")
  const [m3, c] = mustaqil(8, "Amaliyot")
  b.availableFrom = "2026-10-02T00:00:00.000Z"
  const cols = miColumns([m1, a, m2, b, m3, c])
  assert.deepEqual(cols.map((x) => [x.label, x.part, x.points]), [["MI-1", "Ma'ruza", 5], ["MI-1", "Amaliyot", 8], ["MI-2", "Ma'ruza", 10]])
})

test("Nazoratlarda yaratilgan mustaqil ish (mavzusiz) ham taqsimotga kiradi", () => {
  const mi = item({ type: "assignment", controlType: "mustaqil", gradePoints: 15, gradePart: "Ma'ruza" })
  const content = [oraliq("ON1", 10), oraliq("ON2", 10), mi]
  assert.equal(gradeBudget(content).lecture.used, 35)
  assert.notEqual(budgetError(content, item({ type: "exam", controlType: "mustaqil", gradePoints: 1, gradePart: "Ma'ruza" })), null)
  assert.equal(budgetError(content, item({ type: "exam", controlType: "mustaqil", gradePoints: 35, gradePart: "Amaliyot" })), null)
})
