/**
 * Demo hisoblar (lms_demo_accounts) uchun HEMIS proksi javoblarini simulyatsiya
 * qiluvchi soxta ma'lumotlar. Demo hisoblarda haqiqiy HEMIS tokeni yo'q
 * ("demo-token"), shuning uchun haqiqiy HEMIS'ga so'rov yuborish o'rniga shu
 * yerdagi funksiyalar frontend kutayotgan shaklga mos javob qaytaradi.
 */
import type { AuthUser } from "../middleware/auth"

export function isDemoUser(user?: { hemisToken?: string }): boolean {
  return user?.hemisToken === "demo-token"
}

const GROUP_NAMES: Record<number, string> = { 9901: "DEMO-101", 9902: "DEMO-102" }
const FACULTY = { id: 1, name: "Axborot texnologiyalari fakulteti", code: "AT" }
const SPECIALTY = { id: 1, name: "Dasturiy injiniring" }
const DEPARTMENT = { id: 1, name: "Dasturiy injiniring kafedrasi" }
const SEMESTER = { id: 1, name: "2025-2026 1-semestr", code: 15 }
const DEMO_SUBJECT = "Demo fan"
const DEMO_SUBJECT_2 = "Dasturlash asoslari"

function groupName(groupId?: number | null): string {
  return (groupId != null && GROUP_NAMES[groupId]) || "DEMO-101"
}

function splitName(fullName?: string): { first: string; second: string } {
  const parts = (fullName || "Demo Foydalanuvchi").trim().split(/\s+/)
  return { first: parts[0] || "Demo", second: parts.slice(1).join(" ") || "Foydalanuvchi" }
}

function gpaFor(id?: number | string) {
  const n = Number(id) || 0
  return Math.round((2.9 + (n % 12) * 0.09) * 100) / 100
}

export function mockStudentMe(user?: AuthUser) {
  const { first, second } = splitName(user?.fullName)
  const groupId = user?.groupId != null ? Number(user.groupId) : 9901
  const gpa = gpaFor(user?.id ?? user?.userId)
  return {
    id: user?.id ?? user?.userId ?? 0,
    first_name: first,
    second_name: second,
    third_name: "",
    full_name: user?.fullName || "Demo Talaba",
    short_name: user?.fullName || "Demo Talaba",
    student_id_number: `DEMO${String(user?.id ?? user?.userId ?? 0).padStart(6, "0")}`,
    email: `${(user?.username || "demo").toString().toLowerCase().replace(/\s+/g, ".")}@demo.samisi.uz`,
    phone: "+998901234567",
    avg_gpa: gpa,
    gpa,
    gender: { id: 1, name: "Erkak", code: "male" },
    group: { id: groupId, name: groupName(groupId), code: groupName(groupId) },
    faculty: FACULTY,
    specialty: SPECIALTY,
    department: DEPARTMENT,
    educationType: { id: 1, name: "Kunduzgi" },
    educationForm: { id: 1, name: "Grant" },
    educationLang: { id: 1, name: "O'zbek" },
    paymentForm: { id: 1, name: "Grant" },
    level: { id: 1, name: "1-kurs" },
    semester: SEMESTER,
    country: { code: "UZ", name: "O'zbekiston" },
    accommodation: { code: "own", name: "Ijara" },
  }
}

export function mockEmployeeMe(user?: AuthUser) {
  const { first, second } = splitName(user?.fullName)
  return {
    id: user?.id ?? user?.userId ?? 0,
    first_name: first,
    second_name: second,
    third_name: "",
    full_name: user?.fullName || "Demo O'qituvchi",
    short_name: user?.fullName || "Demo O'qituvchi",
    employee_id_number: `DEMO${String(user?.id ?? user?.userId ?? 0).padStart(6, "0")}`,
    gender: { id: 1, name: "Erkak", code: "male" },
    department: DEPARTMENT,
    academicDegree: { id: 1, name: "PhD" },
    academicRank: { id: 1, name: "Dotsent" },
    employmentForm: { id: 1, name: "Asosiy" },
    staffPosition: { id: 1, name: "O'qituvchi" },
    employeeStatus: { id: 1, name: "Faol" },
    employeeType: { id: 1, name: "O'qituvchi" },
    specialty: SPECIALTY.name,
    active: true,
  }
}

function weekLessonDates(count: number, offsetDays = 0): number[] {
  const out: number[] = []
  const base = new Date()
  base.setHours(9, 0, 0, 0)
  base.setDate(base.getDate() - offsetDays)
  for (let i = 0; i < count; i++) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    out.push(Math.floor(d.getTime() / 1000))
  }
  return out
}

export function mockSchedule(user?: AuthUser) {
  const groupId = user?.groupId != null ? Number(user.groupId) : 9901
  const dates = weekLessonDates(5, -4) // shu haftaning besh kuni
  const pairs = [
    { id: 1, name: "1-para", start_time: "09:00", end_time: "10:20" },
    { id: 2, name: "2-para", start_time: "10:40", end_time: "12:00" },
  ]
  return dates.map((lesson_date, i) => ({
    id: i + 1,
    subject: { id: 1, code: "DF-101", name: i % 2 === 0 ? DEMO_SUBJECT : DEMO_SUBJECT_2 },
    group: { id: groupId, name: groupName(groupId) },
    employee: { id: 9501, name: "Demo O'qituvchi" },
    auditorium: { id: 1, name: "101-xona" },
    lessonPair: pairs[i % pairs.length],
    lesson_date,
    trainingType: { id: 1, code: "lecture", name: "Ma'ruza" },
    semester: SEMESTER,
  }))
}

export function mockAttendance(user?: AuthUser) {
  const dates = weekLessonDates(10, 4) // o'tgan ikki hafta
  return dates.map((lesson_date, i) => ({
    id: i + 1,
    subject: { id: 1, code: "DF-101", name: DEMO_SUBJECT },
    semester: SEMESTER,
    trainingType: { id: 1, name: "Ma'ruza" },
    employee: { id: 9501, name: "Demo O'qituvchi" },
    lessonPair: { name: "1-para", start_time: "09:00", end_time: "10:20" },
    lesson_date,
    absent_on: i === 3 ? 1 : 0,
    absent_off: 0,
    explicable: i === 3,
    hours: 2,
    academic_hours: 2,
  }))
}

export function mockGrades() {
  const subjects = [
    { name: DEMO_SUBJECT,        code: "DF-101", point: 92, credit: 4 },
    { name: DEMO_SUBJECT_2,      code: "DF-102", point: 87, credit: 5 },
    { name: "Matematik analiz",  code: "MA-101", point: 78, credit: 4 },
    { name: "Ingliz tili",       code: "EN-101", point: 95, credit: 3 },
    { name: "Ma'lumotlar bazasi",code: "MB-201", point: 83, credit: 4 },
  ]
  return subjects.map((s, i) => ({
    id: i + 1,
    subject_name: s.name,
    subject_code: s.code,
    subject_type: "Majburiy",
    employee_name: "Demo O'qituvchi",
    semester_name: SEMESTER.name,
    total_acload: 60,
    credit: s.credit,
    total_point: s.point,
    grade: Math.round(s.point / 20),
    finish_credit_status: s.point >= 55,
    retraining_status: s.point > 0 && s.point < 55,
    _semester: String(SEMESTER.id),
    _education_year: "2025-2026",
  }))
}

export function mockPerformance() {
  const grades = mockGrades()
  return grades.slice(0, 3).map((g, i) => ({
    id: String(i + 1),
    student: { id: "0", name: "" },
    subject: { id: String(i + 1), name: g.subject_name },
    examDate: new Date(Date.now() - (i + 1) * 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    score: g.total_point,
    examType: { id: "1", name: i === 0 ? "Yakuniy nazorat" : "Oraliq nazorat" },
    employee: { id: "9501", name: "Demo O'qituvchi" },
  }))
}

export function mockDocuments() {
  return [
    { id: 1, name: "O'qishga tavsiyanoma", attributes: [{ label: "Berilgan sana", value: new Date().toLocaleDateString("uz-UZ") }] },
    { id: 2, name: "Talaba ma'lumotnomasi", attributes: [{ label: "Amal qilish muddati", value: "6 oy" }] },
  ]
}

export function mockCertificates() {
  return [
    {
      id: 1,
      name: "Ingliz tili sertifikati",
      certificateType: { code: "lang", name: "Til sertifikati" },
      organization: "SamISI Til markazi",
      score: "B2",
      date: Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60,
    },
  ]
}

export function mockContractList(user?: AuthUser) {
  const total = 12_500_000
  const paid = 8_000_000
  return {
    items: [
      {
        id: 1,
        _data: {
          contractNumber: `DEMO-${String(user?.id ?? user?.userId ?? 0).padStart(4, "0")}`,
          contractAmount: total,
          paidAmount: paid,
          debitAmount: total - paid,
          endRestDebetAmount: total - paid,
          status: "Amaldagi",
          course: "1-kurs",
          speciality: SPECIALTY.name,
          lastPaymentDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toLocaleDateString("uz-UZ"),
          eduYear: "2025-2026",
          fullName: user?.fullName || "Demo Talaba",
        },
        created_at: Math.floor(Date.now() / 1000) - 200 * 24 * 60 * 60,
      },
    ],
    attributes: {},
  }
}
