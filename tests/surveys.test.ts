import { stubDb, token, startApp } from "./helpers"
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  validateSurveyInput, applyScopeToTargets, canManageSurvey, surveyState, buildAnswerRows,
  sameQuestionStructure, suppressSmall, normalizeTargets, SurveyError, type SurveyManager, type QuestionInput,
} from "../src/services/surveyStore"
import surveysRoutes from "../src/routes/surveys"

/* So'rovnomalar moduli: forma tekshiruvi, dekan doirasi, javob tekshiruvi,
   anonim kesimlarni yashirish va boshqaruv API'siga kirish huquqi. */

const day = 86_400_000
const now = new Date("2026-11-18T10:00:00Z")
const base = {
  title: "Ta'lim sifati",
  startAt: new Date(now.getTime() - day).toISOString(),
  endAt: new Date(now.getTime() + 7 * day).toISOString(),
  targets: [{ audience: "student" }],
  questions: [{ type: "yesno", text: "Qoniqasizmi?" }],
}

function rejects(fn: () => unknown, status: number, pattern: RegExp) {
  assert.throws(fn, (err: unknown) => err instanceof SurveyError && err.status === status && pattern.test(err.message))
}

test("forma: nom, sana va e'lon talablari tekshiriladi", () => {
  rejects(() => validateSurveyInput({ ...base, title: "ab" }, { publish: false, now }), 400, /kamida 3/)
  rejects(() => validateSurveyInput({ ...base, endAt: base.startAt }, { publish: false, now }), 400, /boshlanishdan keyin/)
  rejects(() => validateSurveyInput({ ...base, endAt: new Date(now.getTime() - 1000).toISOString(), startAt: new Date(now.getTime() - day).toISOString() }, { publish: true, now }), 400, /o'tib ketgan/)
  rejects(() => validateSurveyInput({ ...base, targets: [] }, { publish: true, now }), 400, /auditoriya/)
  rejects(() => validateSurveyInput({ ...base, questions: [] }, { publish: true, now }), 400, /savol/)
  // Qoralama — savolsiz va auditoriyasiz ham saqlanadi
  const draft = validateSurveyInput({ ...base, targets: [], questions: [] }, { publish: false, now })
  assert.equal(draft.questions.length, 0)
  assert.equal(draft.isAnonymous, true, "sukut bo'yicha anonim")
})

test("forma: savol variantlari va shkala", () => {
  rejects(() => validateSurveyInput({ ...base, questions: [{ type: "single", text: "Q", options: ["Faqat bitta"] }] }, { publish: false, now }), 400, /kamida 2/)
  rejects(() => validateSurveyInput({ ...base, questions: [{ type: "multiple", text: "Q", options: ["Ha", "ha"] }] }, { publish: false, now }), 400, /takrorlangan/)
  rejects(() => validateSurveyInput({ ...base, questions: [{ type: "boshqa", text: "Q" }] }, { publish: false, now }), 400, /turi/)
  const v = validateSurveyInput({
    ...base,
    questions: [
      { type: "scale", text: "1-10", scaleMax: 10 },
      { type: "scale", text: "1-5", scaleMax: 7 },
      { type: "rating", text: "Yulduz", scaleMax: 10 },
      { type: "text", text: "Fikr", required: false, options: ["e'tiborsiz"] },
    ],
  }, { publish: false, now })
  assert.deepEqual(v.questions.map((q) => q.scaleMax), [10, 5, 5, null])
  assert.equal(v.questions[3].required, false)
  assert.equal(v.questions[3].options.length, 0)
})

test("auditoriya qoidalari tozalanadi", () => {
  const rules = normalizeTargets([
    { audience: "student", faculties: [" A ", "A", ""], groupIds: [5, "6", -1, "x"] },
    { audience: "admin" },
    "yaroqsiz",
  ])
  assert.deepEqual(rules, [{ audience: "student", faculties: ["A"], specialties: [], courses: [], groupIds: [5, 6] }])
})

test("dekan doirasi: fakultetsiz dekan yaratolmaydi, boshqa fakultet rad etiladi", () => {
  const rule = { audience: "student" as const, faculties: [], specialties: [], courses: [], groupIds: [] }
  assert.deepEqual(applyScopeToTargets([rule], null), [rule], "admin — o'zgarishsiz")
  rejects(() => applyScopeToTargets([rule], []), 403, /fakultet biriktirilmagan/)
  assert.deepEqual(applyScopeToTargets([rule], ["Masofaviy"])[0].faculties, ["Masofaviy"])
  rejects(() => applyScopeToTargets([{ ...rule, faculties: ["Magistratura"] }], ["Masofaviy"]), 403, /doirangizga kirmaydi/)
})

test("dekan faqat o'z doirasidagi so'rovnomalarni boshqaradi", () => {
  const dean: SurveyManager = { hemisId: "10", name: "D", role: "dean", faculties: ["A", "B"] }
  const admin: SurveyManager = { hemisId: "1", name: "A", role: "admin", faculties: null }
  assert.equal(canManageSurvey({ createdById: "1", scopeFaculties: null }, admin), true)
  assert.equal(canManageSurvey({ createdById: "1", scopeFaculties: null }, dean), false, "admin yaratgan umumiy so'rovnoma")
  assert.equal(canManageSurvey({ createdById: "10", scopeFaculties: null }, dean), true, "o'zi yaratgan")
  assert.equal(canManageSurvey({ createdById: "11", scopeFaculties: ["A"] }, dean), true, "shu fakultetning boshqa dekani")
  assert.equal(canManageSurvey({ createdById: "11", scopeFaculties: ["A", "C"] }, dean), false, "doirasi kengroq")
})

test("holat: qoralama, rejada, faol, to'xtatilgan, yakunlangan, arxiv", () => {
  const s = { status: "published", isActive: true, archivedAt: null, startAt: base.startAt, endAt: base.endAt }
  assert.equal(surveyState({ ...s, status: "draft" }, now), "draft")
  assert.equal(surveyState(s, now), "active")
  assert.equal(surveyState({ ...s, isActive: false }, now), "paused")
  assert.equal(surveyState({ ...s, startAt: new Date(now.getTime() + day).toISOString() }, now), "scheduled")
  assert.equal(surveyState({ ...s, endAt: new Date(now.getTime() - 1).toISOString() }, now), "finished")
  assert.equal(surveyState({ ...s, archivedAt: now.toISOString() }, now), "archived")
})

const questions = [
  { id: 1, type: "single" as const, text: "S", required: true, scaleMax: null, allowOther: true, options: [{ id: 11, text: "a" }, { id: 12, text: "b" }] },
  { id: 2, type: "multiple" as const, text: "M", required: false, scaleMax: null, allowOther: false, options: [{ id: 21, text: "x" }, { id: 22, text: "y" }] },
  { id: 3, type: "scale" as const, text: "Sh", required: true, scaleMax: 10, allowOther: false, options: [] },
  { id: 4, type: "yesno" as const, text: "H", required: true, scaleMax: null, allowOther: false, options: [] },
  { id: 5, type: "text" as const, text: "T", required: false, scaleMax: null, allowOther: false, options: [] },
]

test("javob: majburiy savollar, variantlar va qiymat chegaralari", () => {
  const ok = { 1: { optionIds: [11] }, 2: { optionIds: [21, 22] }, 3: { value: 10 }, 4: { value: 0 }, 5: { text: "  fikr  " } }
  const rows = buildAnswerRows(questions, ok)
  assert.deepEqual(rows.map((r) => [r.questionId, r.optionId, r.valueNumber, r.valueText]), [
    [1, 11, null, null], [2, 21, null, null], [2, 22, null, null], [3, 0, 10, null], [4, 0, 0, null], [5, 0, null, "fikr"],
  ])
  rejects(() => buildAnswerRows(questions, { ...ok, 1: {} }), 400, /1-savol majburiy/)
  rejects(() => buildAnswerRows(questions, { ...ok, 1: { optionIds: [11, 12] } }), 400, /bitta javob/)
  rejects(() => buildAnswerRows(questions, { ...ok, 1: { optionIds: [11], text: "boshqa" } }), 400, /bitta javob/)
  rejects(() => buildAnswerRows(questions, { ...ok, 2: { optionIds: [11] } }), 400, /noma'lum variant/)
  rejects(() => buildAnswerRows(questions, { ...ok, 3: { value: 11 } }), 400, /1–10/)
  rejects(() => buildAnswerRows(questions, { ...ok, 4: { value: 2 } }), 400, /0–1/)
  // "Boshqa" matni bitta javob sifatida qabul qilinadi; ixtiyoriy savollar bo'sh qolishi mumkin
  const other = buildAnswerRows(questions, { 1: { text: "o'zim yozdim" }, 3: { value: 1 }, 4: { value: 1 } })
  assert.deepEqual(other[0], { questionId: 1, optionId: 0, valueNumber: null, valueText: "o'zim yozdim" })
})

test("javob kelgach savol tuzilishi o'zgarmaydi, faqat matn", () => {
  const existing: QuestionInput[] = questions.map((q) => ({ ...q }))
  const typo = existing.map((q) => ({ ...q, text: `${q.text} (tuzatildi)`, options: q.options.map((o) => ({ ...o, text: `${o.text}!` })) }))
  assert.equal(sameQuestionStructure(existing, typo), true)
  assert.equal(sameQuestionStructure(existing, existing.slice(1)), false, "savol o'chirildi")
  assert.equal(sameQuestionStructure(existing, [{ ...existing[0], options: existing[0].options.slice(0, 1) }, ...existing.slice(1)]), false, "variant o'chirildi")
  assert.equal(sameQuestionStructure(existing, [{ ...existing[0], type: "multiple" }, ...existing.slice(1)]), false, "tur o'zgardi")
  assert.equal(sameQuestionStructure(existing, [{ ...existing[0], id: undefined }, ...existing.slice(1)]), false, "yangi savol")
})

test("anonim natijada 5 tadan kam javobli kesim yashiriladi", () => {
  assert.equal(suppressSmall(3, true), true)
  assert.equal(suppressSmall(5, true), false)
  assert.equal(suppressSmall(0, true), false, "javob yo'q — yashiradigan narsa yo'q")
  assert.equal(suppressSmall(1, false), false, "ochiq so'rovnoma")
})

test("boshqaruv API: talaba va oddiy o'qituvchi kira olmaydi, tokensiz 401", async () => {
  stubDb((sql) => {
    if (/FROM lms_permissions/.test(sql)) return []
    return undefined
  })
  const app = await startApp((a) => a.use("/api/surveys", surveysRoutes))
  try {
    const noToken = await fetch(`${app.base}/api/surveys/manage`)
    assert.equal(noToken.status, 401)
    for (const role of ["student", "employee"]) {
      const res = await fetch(`${app.base}/api/surveys/manage`, { headers: { Authorization: `Bearer ${token({ id: 4242, role })}` } })
      assert.equal(res.status, 403, role)
      const created = await fetch(`${app.base}/api/surveys/manage`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token({ id: 4242, role })}`, "Content-Type": "application/json" },
        body: JSON.stringify(base),
      })
      assert.equal(created.status, 403, `${role} yarata olmaydi`)
    }
  } finally {
    await app.close()
  }
})

test("javob yuborish: mo'ljallanmagan foydalanuvchi 403, yopilgan so'rovnoma 409", async () => {
  const survey = {
    id: 7, title: "S", description: null, survey_type: "umumiy", is_anonymous: 1, status: "published", is_active: 1,
    start_at: new Date(Date.now() - day), end_at: new Date(Date.now() + day), estimated_minutes: null,
    reminder_interval_days: 3, scope_faculties: null, created_by_id: "1", created_by_name: null, created_by_role: "admin",
    published_at: null, archived_at: null, created_at: new Date(), updated_at: new Date(),
  }
  let current = survey
  let participation: Record<string, unknown>[] = []
  stubDb((sql) => {
    if (/FROM lms_surveys WHERE id = \?/.test(sql)) return [current]
    if (/FROM lms_survey_participations/.test(sql)) return participation
    if (/FROM lms_survey_questions/.test(sql)) return [{ id: 1, position: 0, type: "yesno", text: "H", is_required: 1, scale_max: null, allow_other: 0 }]
    if (/FROM lms_survey_options/.test(sql)) return []
    return undefined
  })
  // Tranzaksiya: ishtirokchi topilmaydi
  const { pool } = await import("../src/services/db")
  const conn = {
    query: async (sql: string) => {
      if (/FROM lms_survey_participations/.test(sql)) return [[], []]
      return [[], []]
    },
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
  }
  ;(pool as unknown as { getConnection: unknown }).getConnection = async () => conn
  const app = await startApp((a) => a.use("/api/surveys", surveysRoutes))
  try {
    const auth = { Authorization: `Bearer ${token({ id: 55, role: "student" })}`, "Content-Type": "application/json" }
    const outsider = await fetch(`${app.base}/api/surveys/7/submit`, { method: "POST", headers: auth, body: JSON.stringify({ answers: { 1: { value: 1 } } }) })
    assert.equal(outsider.status, 403)
    // Allaqachon javob bergan — javob tekshiruvidan oldin aniq 409 (bo'sh javob bilan ham)
    participation = [{ id: 1, survey_id: 7, user_role: "student", user_id: 55, status: "completed" }]
    const again = await fetch(`${app.base}/api/surveys/7/submit`, { method: "POST", headers: auth, body: JSON.stringify({ answers: {} }) })
    assert.equal(again.status, 409)
    assert.match((await again.json()).message, /allaqachon/)
    current = { ...survey, end_at: new Date(Date.now() - 1000) }
    const closed = await fetch(`${app.base}/api/surveys/7/submit`, { method: "POST", headers: auth, body: JSON.stringify({ answers: { 1: { value: 1 } } }) })
    assert.equal(closed.status, 409)
  } finally {
    await app.close()
  }
})
