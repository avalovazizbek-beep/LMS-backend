import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { studentJn, type JnTopic } from "../src/services/gradeJournal"

/* JN = (35 − amaliyot mustaqil ishi) ÷ topshiriqlar soni, har topshiriq
   100 ballikda baholanadi va foizi ulushga aylanadi. */

const topic = (n: number, closed = false): JnTopic => ({ key: `t${n}`, maxScore: 100, closed, graded: [{ id: n, maxScore: 100 }] })
const ten = Array.from({ length: 10 }, (_, i) => topic(i + 1))

test("10 ta topshiriq, mustaqil ishsiz: har biri 3.5, hammasi 100 → 35", () => {
  const grades = new Map(ten.map((t, i) => [`${i + 1}:7`, 100]))
  assert.equal(studentJn(ten, 35 / 10, 7, grades).jn, 35)
})

test("5 ballik amaliyot mustaqil ishi bilan: har topshiriq 3 ball, 80% → 2.4", () => {
  const grades = new Map<string, number | null>([["1:7", 100], ["2:7", 80]])
  const r = studentJn(ten, 30 / 10, 7, grades)
  assert.equal(r.topicPoints.t1, 3)
  assert.equal(r.topicPoints.t2, 2.4)
  assert.equal(r.topicPoints.t3, null)           // hali ochiq, topshirilmagan — hisobga kirmaydi
  assert.equal(r.jn, 5)                           // 3 + 2.4 = 5.4 → semestr davomida to'planadi
})

test("muddati o'tgan, topshirilmagan — 0; baholanmagani — hisobga kirmaydi", () => {
  const topics = [topic(1, true), topic(2, true)]
  const r = studentJn(topics, 15, 7, new Map<string, number | null>([["2:7", null]]))
  assert.equal(r.topicPoints.t1, 0)
  assert.equal(r.topicPoints.t2, null)
  assert.equal(r.jn, 0)
})
