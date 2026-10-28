import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { stubDb } from "./helpers"
import { replaceTeacherGroups } from "../src/services/teachingStore"
import { SINOV_GROUP_ID } from "../src/services/sinovIds"

/* HEMIS sinxronizatsiyasi o'qituvchining guruhlarini qayta yozadi — sinov
   guruhi (HEMIS'da yo'q) o'chib ketmasligi kerak. */
test("replaceTeacherGroups sinov guruhini o'chirmaydi", async () => {
  const calls: [string, unknown[]][] = []
  stubDb((sql, params) => { calls.push([sql, params]); return [] })
  await replaceTeacherGroups(771, [865])
  const del = calls.find(([sql]) => sql.startsWith("DELETE FROM lms_teacher_groups"))
  assert.ok(del)
  assert.match(del[0], /group_id <> \?/)
  assert.deepEqual(del[1], [771, SINOV_GROUP_ID])
})
