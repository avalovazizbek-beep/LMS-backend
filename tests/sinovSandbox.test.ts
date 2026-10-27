import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { stubDb } from "./helpers"
import { withSinovControls, SINOV_GROUP_ID } from "../src/services/sinovSandbox"

/* Sinov guruhi biriktirilgan o'qituvchining HEMIS nazoratlar ro'yxatiga
   "1-on" / "2-on" qo'shiladi; boshqalarga va boshqa resurslarga — yo'q. */

function teacherGroups(ids: number[]) {
  stubDb((sql) => (sql.includes("lms_teacher_groups") ? ids.map((group_id) => ({ group_id })) : undefined))
}

const real = { examType: { name: "1-on" }, group: { id: 865, name: "BH-M-425" } }

test("sinov guruhi bor o'qituvchida 1-on va 2-on qo'shiladi", async () => {
  teacherGroups([865, SINOV_GROUP_ID])
  const out = await withSinovControls("controls", 771, { data: [real], source: "x" })
  const items = out.data as Array<{ examType: { name: string }; group: { id: number } }>
  assert.equal(items.length, 3)
  assert.deepEqual(items.slice(1).map((i) => [i.examType.name, i.group.id]), [["1-on", SINOV_GROUP_ID], ["2-on", SINOV_GROUP_ID]])
})

test("sinov guruhi yo'q o'qituvchida ro'yxat o'zgarmaydi", async () => {
  teacherGroups([865])
  const out = await withSinovControls("controls", 1, { data: [real] })
  assert.deepEqual(out.data, [real])
})

test("nazoratlardan boshqa resursga tegmaydi", async () => {
  teacherGroups([SINOV_GROUP_ID])
  const result = { data: [real] }
  assert.equal(await withSinovControls("lessons", 771, result), result)
})
