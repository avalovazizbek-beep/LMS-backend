# Meeting Recording Moduli (MVP)

## Maqsad

Onlayn dars yoki meeting jarayonini to'liq yozib olish, serverga saqlash va keyinchalik talabalarga ko'rsatish imkoniyatini yaratish.

---

# Muammo

Hozirgi meeting tizimida foydalanuvchilar jonli ravishda qatnashishi mumkin, ammo dars yakunlangandan keyin uni qayta ko'rish imkoniyati mavjud emas.

Bu esa:

* Darsni o'tkazib yuborgan talabalar uchun muammo tug'diradi.
* Mavzuni qayta ko'rib chiqish imkoniyatini cheklaydi.
* Platformaning qiymatini pasaytiradi.

---

# Yechim

Meeting davomida ekran va ovoz yozib olinadi.

Meeting tugagach:

1. Video avtomatik serverga yuklanadi.
2. Server videoni saqlaydi.
3. Video ma'lumotlari bazaga yoziladi.
4. Talabalar dars sahifasi orqali videoni ko'rishlari mumkin bo'ladi.

---

# Tizim Arxitekturasi

## Frontend

Vazifalari:

* Meeting boshlanganda recordingni ishga tushirish.
* Ekran va ovozni yozib olish.
* Meeting tugaganda videoni serverga yuborish.

---

## Backend

Vazifalari:

* Kelgan videoni qabul qilish.
* Server diskiga saqlash.
* Video haqida ma'lumotlarni bazaga yozish.
* Talabalarga videoni uzatish.

---

## Database

Bazada video faylning o'zi emas, faqat ma'lumotlari saqlanadi.

Masalan:

* Video ID
* Dars ID
* Fayl nomi
* Fayl manzili
* Yaratilgan vaqt

---

# Fayllarni Saqlash

Serverda alohida papka yaratiladi:

uploads/
recordings/

Har bir meeting shu yerga joylanadi.

Misol:

uploads/recordings/meeting_001.webm

---

# Talabalar Uchun

Talaba dars sahifasiga kiradi.

Tizim:

1. Shu darsga tegishli recording mavjudligini tekshiradi.
2. Agar mavjud bo'lsa videoni ko'rsatadi.
3. Talaba videoni platforma ichida tomosha qiladi.

---

# Kelajakdagi Imkoniyatlar

## 1-bosqich (MVP)

* Recording olish
* Serverga saqlash
* Talabalarga ko'rsatish

## 2-bosqich

* Recordinglarni qidirish
* Dars bo'yicha filtrlash
* Yuklab olish

## 3-bosqich

* Videoni avtomatik siqish
* Video sifatini tanlash
* Video preview (thumbnail)

## 4-bosqich

* Recordinglarni bulutga ko'chirish
* CDN orqali tez uzatish
* Katta hajmdagi trafikni qo'llab-quvvatlash

---

# Xarajatlar

Ushbu MVP uchun:

* Zoom API kerak emas
* Google Meet API kerak emas
* Pullik recording servislari kerak emas

Faqat:

* Mavjud VPS yoki server
* Express Backend
* MySQL Database

ishlatiladi.

Shuning uchun dastlabki bosqichda qo'shimcha xizmat xarajatlari deyarli bo'lmaydi.

---

# Xulosa

Recording moduli yordamida har bir meeting avtomatik yozib olinadi, serverga saqlanadi va talabalar keyinchalik platforma orqali darslarni qayta ko'rish imkoniyatiga ega bo'ladi. MVP bosqichida tashqi pullik APIlardan foydalanilmaydi va barcha jarayonlar o'z serverimizda amalga oshiriladi.

