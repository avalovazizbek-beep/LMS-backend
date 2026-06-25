import { v4 as uuid } from "uuid"
import bcrypt from "bcryptjs"

/* ── Types ─────────────────────────────────────────────────────── */

export type Role = "super_admin" | "admin" | "moderator" | "seller" | "master" | "student"
export type Status = "active" | "inactive"

export interface User {
  id: string
  fullName: string
  username: string
  phone: string
  password: string
  role: Role
  status: Status
  createdAt: string
}

export interface Admin extends User { role: "admin" | "super_admin" }
export interface Moderator extends User {
  role: "moderator"
  permissions: string[]
}
export interface Seller extends User {
  role: "seller"
  sales: number
}
export interface Master extends User {
  role: "master"
  subject: string
  rating: number
}

export interface Group {
  id: string
  name: string
  course: number
  direction: string
  students: number
  tutor: string
  status: Status
  createdAt: string
}

export interface Exam {
  id: string
  subject: string
  group: string
  date: string
  time: string
  duration: string
  room: string
  teacher: string
  type: "Yozma" | "Og'zaki" | "Test"
  status: "scheduled" | "ongoing" | "completed" | "cancelled"
  createdAt: string
}

export interface Payment {
  id: string
  student: string
  group: string
  semester: number
  total: number
  paid: number
  dueDate: string
  status: "paid" | "pending" | "overdue" | "partial"
  createdAt: string
}

export interface Document {
  id: string
  title: string
  category: string
  type: "pdf" | "word" | "excel" | "image" | "other"
  size: string
  author: string
  date: string
  downloads: number
}

export interface Meeting {
  id: string
  title: string
  subject: string
  host: string
  date: string
  time: string
  duration: string
  participants: number
  link: string
  status: "upcoming" | "done"
}

export interface Notification {
  id: string
  type: "system" | "teacher" | "schedule" | "reminder"
  title: string
  body: string
  time: string
  read: boolean
  userId: string
}

export interface BoardPost {
  id: string
  title: string
  body: string
  tag: string
  date: string
  pinned: boolean
  author: string
}

/* ── Seed data ──────────────────────────────────────────────────── */

const hash = (p: string) => bcrypt.hashSync(p, 10)

export const users: User[] = [
  { id: uuid(), fullName: "Admin",              username: "admin",         phone: "+998900000000", password: hash("admin123"),  role: "super_admin", status: "active",   createdAt: "2024-01-00" },
  { id: uuid(), fullName: "Yusupov Kamol",     username: "admin_kamol",   phone: "+998901112233", password: hash("admin123"),  role: "super_admin", status: "active",   createdAt: "2024-01-01" },
  { id: uuid(), fullName: "Normatova Zulfiya",  username: "admin_z",       phone: "+998912223344", password: hash("admin123"),  role: "admin",       status: "active",   createdAt: "2024-01-02" },
  { id: uuid(), fullName: "Qodirov Mansur",     username: "admin_mansur",  phone: "+998933334455", password: hash("admin123"),  role: "admin",       status: "active",   createdAt: "2024-01-03" },
  { id: uuid(), fullName: "Tosheva Madina",     username: "mod_madina",    phone: "+998904445566", password: hash("mod123"),    role: "moderator",   status: "active",   createdAt: "2024-01-04" },
  { id: uuid(), fullName: "Xoliqov Sarvar",     username: "mod_sarvar",    phone: "+998915556677", password: hash("mod123"),    role: "moderator",   status: "active",   createdAt: "2024-01-05" },
  { id: uuid(), fullName: "Rahimov Nodir",      username: "seller_nodir",  phone: "+998904445566", password: hash("seller123"), role: "seller",      status: "active",   createdAt: "2024-01-06" },
  { id: uuid(), fullName: "Mirzaeva Gulnora",   username: "seller_gul",    phone: "+998915556677", password: hash("seller123"), role: "seller",      status: "active",   createdAt: "2024-01-07" },
  { id: uuid(), fullName: "Tursunov Bekzod",    username: "seller_bek",    phone: "+998936667788", password: hash("seller123"), role: "seller",      status: "inactive", createdAt: "2024-01-08" },
  { id: uuid(), fullName: "Karimov Alisher",    username: "master_alisher",phone: "+998901234567", password: hash("master123"), role: "master",      status: "active",   createdAt: "2024-01-09" },
  { id: uuid(), fullName: "Tosheva Gulbahor",   username: "master_gul",    phone: "+998912345678", password: hash("master123"), role: "master",      status: "active",   createdAt: "2024-01-10" },
  { id: uuid(), fullName: "Aliyev Jasur",       username: "student_jasur", phone: "+998901111111", password: hash("student123"),role: "student",     status: "active",   createdAt: "2024-01-11" },
]

export const groups: Group[] = [
  { id: uuid(), name: "AT-101", course: 1, direction: "Axborot texnologiyalari", students: 25, tutor: "Rahimov D.", status: "active",   createdAt: "2024-01-01" },
  { id: uuid(), name: "AT-201", course: 2, direction: "Axborot texnologiyalari", students: 22, tutor: "Nazarov B.", status: "active",   createdAt: "2024-01-01" },
  { id: uuid(), name: "FM-101", course: 1, direction: "Fizika-matematika",       students: 20, tutor: "Karimov A.", status: "active",   createdAt: "2024-01-01" },
  { id: uuid(), name: "FM-301", course: 3, direction: "Fizika-matematika",       students: 18, tutor: "Tosheva G.", status: "inactive", createdAt: "2024-01-01" },
  { id: uuid(), name: "IQ-102", course: 1, direction: "Iqtisodiyot",             students: 28, tutor: "Yusupov S.", status: "active",   createdAt: "2024-01-01" },
  { id: uuid(), name: "IQ-202", course: 2, direction: "Iqtisodiyot",             students: 24, tutor: "Mirzaeva N.",status: "active",   createdAt: "2024-01-01" },
  { id: uuid(), name: "BH-M-425", course: 1, direction: "Buxgalteriya hisobi",   students: 1,  tutor: "",           status: "active",   createdAt: "2026-05-15" },
]

export const exams: Exam[] = [
  { id: uuid(), subject: "Matematika", group: "AT-101", date: "2024-05-20", time: "09:00", duration: "2 soat",   room: "101-xona", teacher: "Karimov A.",  type: "Yozma",   status: "scheduled", createdAt: "2024-04-01" },
  { id: uuid(), subject: "Fizika",     group: "FM-101", date: "2024-05-22", time: "11:00", duration: "1.5 soat", room: "Lab-1",    teacher: "Nazarov B.",  type: "Test",    status: "scheduled", createdAt: "2024-04-01" },
  { id: uuid(), subject: "Ingliz tili",group: "AT-201", date: "2024-05-18", time: "14:00", duration: "1 soat",   room: "205-xona", teacher: "Tosheva G.",  type: "Og'zaki", status: "ongoing",   createdAt: "2024-04-01" },
  { id: uuid(), subject: "Informatika",group: "IQ-102", date: "2024-05-15", time: "10:00", duration: "2 soat",   room: "Komp-1",   teacher: "Rahimov D.",  type: "Test",    status: "completed", createdAt: "2024-04-01" },
  { id: uuid(), subject: "Kimyo",      group: "FM-301", date: "2024-05-10", time: "09:00", duration: "2 soat",   room: "Lab-2",    teacher: "Yusupov S.",  type: "Yozma",   status: "completed", createdAt: "2024-04-01" },
  { id: uuid(), subject: "Iqtisodiyot",group: "IQ-202", date: "2024-05-25", time: "13:00", duration: "2 soat",   room: "301-xona", teacher: "Mirzaeva N.", type: "Yozma",   status: "cancelled", createdAt: "2024-04-01" },
]

export const payments: Payment[] = [
  { id: uuid(), student: "Aliyev Jasur",       group: "AT-101", semester: 1, total: 4500000, paid: 4500000, dueDate: "2024-02-01", status: "paid",    createdAt: "2024-01-15" },
  { id: uuid(), student: "Karimova Dilnoza",   group: "AT-201", semester: 2, total: 4500000, paid: 2250000, dueDate: "2024-03-15", status: "partial", createdAt: "2024-02-01" },
  { id: uuid(), student: "Toshmatov Behruz",   group: "FM-101", semester: 1, total: 3800000, paid: 0,       dueDate: "2024-02-28", status: "overdue", createdAt: "2024-02-01" },
  { id: uuid(), student: "Nazarova Shahlo",    group: "IQ-102", semester: 2, total: 3200000, paid: 3200000, dueDate: "2024-03-01", status: "paid",    createdAt: "2024-02-15" },
  { id: uuid(), student: "Rustamov Sherzod",   group: "FM-301", semester: 3, total: 4000000, paid: 0,       dueDate: "2024-04-30", status: "pending", createdAt: "2024-03-01" },
  { id: uuid(), student: "Mirzayeva Feruza",   group: "IQ-202", semester: 2, total: 3200000, paid: 1600000, dueDate: "2024-03-20", status: "partial", createdAt: "2024-03-01" },
]

export const documents: Document[] = [
  { id: uuid(), title: "O'quv yili rejasi 2023-2024", category: "O'quv reja", type: "pdf",   size: "2.4 MB",  author: "Dekanat",          date: "2024-01-10", downloads: 145 },
  { id: uuid(), title: "Talabalar nizomi",            category: "Nizom",      type: "word",  size: "1.1 MB",  author: "Rektorat",         date: "2024-01-05", downloads: 89  },
  { id: uuid(), title: "To'lov shartnomalari namunasi",category: "Shartnoma", type: "word",  size: "0.8 MB",  author: "Moliya bo'limi",   date: "2024-02-01", downloads: 212 },
  { id: uuid(), title: "Imtihon jadvali — May 2024", category: "Jadval",     type: "excel", size: "0.5 MB",  author: "O'quv bo'limi",    date: "2024-04-15", downloads: 330 },
  { id: uuid(), title: "Davomat hisoboti Q1",        category: "Hisobot",    type: "excel", size: "1.8 MB",  author: "Tarbiya bo'limi",  date: "2024-04-01", downloads: 67  },
  { id: uuid(), title: "LMS API hujjatlari",         category: "Texnik",     type: "other", size: "3.1 MB",  author: "IT bo'limi",       date: "2024-04-10", downloads: 28  },
]

export const meetings: Meeting[] = [
  { id: uuid(), title: "Matematika — Oraliq muhokama",    subject: "Matematika", host: "Prof. Karimov A.",  date: "2024-04-15", time: "10:00", duration: "60 daqiqa", participants: 24, link: "#", status: "upcoming" },
  { id: uuid(), title: "Fizika laboratoriya taqdimoti",   subject: "Fizika",     host: "Prof. Nazarov B.",  date: "2024-04-17", time: "14:00", duration: "90 daqiqa", participants: 18, link: "#", status: "upcoming" },
  { id: uuid(), title: "Ingliz tili — Speaking Practice", subject: "Ingliz tili",host: "Dos. Tosheva G.",   date: "2024-04-18", time: "09:00", duration: "45 daqiqa", participants: 12, link: "#", status: "upcoming" },
  { id: uuid(), title: "Informatika: Python loyihasi",    subject: "Informatika",host: "Dos. Rahimov D.",   date: "2024-04-08", time: "11:00", duration: "75 daqiqa", participants: 20, link: "#", status: "done"     },
  { id: uuid(), title: "Guruh yig'ilishi — Dekanat",      subject: "Umumiy",     host: "Dekan Yusupov K.",  date: "2024-04-05", time: "15:00", duration: "30 daqiqa", participants: 35, link: "#", status: "done"     },
]

export const notifications: Notification[] = [
  { id: uuid(), type: "system",   title: "Tizim yangilandi",        body: "LMS tizimiga yangi funksiyalar qo'shildi.",                              time: "2 daqiqa oldin",  read: false, userId: "all" },
  { id: uuid(), type: "teacher",  title: "Prof. Karimov xabari",    body: "Matematika fanidan uy vazifasi: 5.1-5.3 mashqlarni bajaring.",           time: "1 soat oldin",    read: false, userId: "all" },
  { id: uuid(), type: "schedule", title: "Dars jadvali o'zgardi",   body: "Chorshanba kuni Fizika darsi 09:00 dan 11:00 ga o'tkazildi.",            time: "3 soat oldin",    read: false, userId: "all" },
  { id: uuid(), type: "reminder", title: "Imtihon eslatmasi",       body: "Matematika yakuniy imtihoni 20-may kuni. 3 kun qoldi!",                 time: "5 soat oldin",    read: true,  userId: "all" },
  { id: uuid(), type: "teacher",  title: "Dos. Tosheva xabari",     body: "Ingliz tili fanidan mustaqil ish topshirildi.",                          time: "1 kun oldin",     read: true,  userId: "all" },
  { id: uuid(), type: "system",   title: "To'lov eslatmasi",        body: "3-semestr to'lovi muddati yaqinlashmoqda. 30-aprelgacha to'lang.",       time: "1 kun oldin",     read: true,  userId: "all" },
]

export const boardPosts: BoardPost[] = [
  { id: uuid(), title: "Imtihon jadvali e'lon qilindi",  body: "May oyida bo'ladigan yakuniy imtihonlar jadvali e'lon qilindi.",              tag: "Muhim",  date: "2024-04-10", pinned: true,  author: "O'quv bo'limi" },
  { id: uuid(), title: "Yangi seminarlar ro'yxati",      body: "2024-yilning bahor semestri uchun qo'shimcha seminarlar rejalashtirildi.",    tag: "E'lon",  date: "2024-04-08", pinned: false, author: "Dekanat"       },
  { id: uuid(), title: "Stipendiya to'lovlari haqida",   body: "Aprel oyiga mo'ljallangan stipendiya to'lovlari 15-apreldan boshlanadi.",    tag: "Moliya", date: "2024-04-07", pinned: false, author: "Moliya bo'limi" },
  { id: uuid(), title: "LMS tizimi yangilandi",          body: "LMS tizimiga yangi imkoniyatlar: onlayn test, video darslar va boshqalar.",  tag: "Texnik", date: "2024-04-03", pinned: true,  author: "IT bo'limi"    },
]

