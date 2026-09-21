// wrtc'ning rasmiy TypeScript turlari yo'q. Bu faylda hech qanday
// import/export bo'lmasligi SHART — aks holda TypeScript buni "mavjud
// modulni kengaytirish" (module augmentation) deb tushunadi, wrtc esa
// turlari yo'q (untyped) modul bo'lgani uchun kengaytirib bo'lmaydi
// (TS2665). Shu fayl `src/**/*` ostida bo'lgani uchun tsconfig'ning
// "include" ro'yxatiga kiradi va scripts/ papkasidagi kod ham buni ko'radi.
declare module "wrtc"
