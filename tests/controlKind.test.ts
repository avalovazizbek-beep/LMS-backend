import "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { controlKind } from "../src/routes/hemis"

/* Xodim → Nazoratlar: HEMIS subject-exam-list yozuvi qaysi sahifada chiqadi.
   O'quv bo'limi oraliqni «1-on» / «2-on» turi bilan qo'yadi — u «Boshqa
   nazoratlar»da emas, «Oraliq nazorat»da ko'rinishi kerak. */

const item = (name: string) => ({ examType: { code: "17", name } })

test("1-on, 2-on, ON-1, 2-oraliq — oraliq nazorat", () => {
  for (const name of ["1-on", "2-on", "1 on", "ON-1", "on2", "2-oraliq", "Oraliq nazorat", "1-ОН"]) {
    assert.equal(controlKind(item(name)), "midterm", name)
  }
})

test("yakuniy va boshqa turlar o'z joyida qoladi", () => {
  assert.equal(controlKind(item("Yakuniy nazorat")), "final")
  assert.equal(controlKind(item("Kurs ishi himoyasi")), "other")
  assert.equal(controlKind(item("Python 1")), "other")
  assert.equal(controlKind(item("3-on")), "other")
})
