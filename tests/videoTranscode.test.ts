import { STORAGE } from "./setup"
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "child_process"
import fs from "fs"
import path from "path"
import { toolBinary, runProcess, ffmpegArgs, isAllowedContainer, fileArg, probe, ALLOWED_DEMUXERS, type Tool } from "../src/services/videoTranscode"

/* Buyruq in'ektsiyasi va ffmpeg kirish fayli bo'yicha regressiya testlari */

test("toolBinary: .env'dagi yo'l faqat mutlaq va aynan ffmpeg/ffprobe bo'lsa", () => {
  const abs = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "/usr/bin/ffmpeg"
  assert.equal(toolBinary("ffmpeg", undefined), "ffmpeg")
  assert.equal(toolBinary("ffmpeg", ""), "ffmpeg")
  assert.equal(toolBinary("ffmpeg", abs), abs)
  for (const bad of ["ffmpeg; rm -rf /", "/bin/sh", "sh -c id", "./ffmpeg", "ffmpeg && id", "/usr/bin/ffprobe", "$(id)"]) {
    assert.equal(toolBinary("ffmpeg", bad), "ffmpeg", bad)
  }
})

test("runProcess: ro'yxatdan tashqari dastur ishga tushmaydi", async () => {
  await assert.rejects(runProcess("sh" as Tool, ["-c", "echo pwned"], 1000), /ruxsat etilmagan/)
  await assert.rejects(runProcess("ffmpeg; id" as Tool, [], 1000), /ruxsat etilmagan/)
})

test("ffmpegArgs: fayl yo'li bitta argument, file: protokoli va whitelistlar bilan", () => {
  const input = "/data/a; touch PWNED $(id) `id` | cat.mp4"
  const output = "-y.mp4"
  const args = ffmpegArgs(input, output, { action: "encode", audioCopy: false, reason: "test" })
  assert.equal(args[args.indexOf("-i") + 1], fileArg(input))
  assert.equal(args[args.length - 1], `file:${output}`, "'-' bilan boshlangan nom opsiya deb o'qilmasin")
  assert.ok(args.indexOf("-protocol_whitelist") < args.indexOf("-i"))
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file")
  assert.equal(args[args.indexOf("-format_whitelist") + 1], ALLOWED_DEMUXERS.join(","))
  assert.ok(!ALLOWED_DEMUXERS.some((d) => ["hls", "concat", "image2", "lavfi", "tee", "http"].includes(d)))
})

test("isAllowedContainer: playlist/concat formatlari rad etiladi", () => {
  assert.equal(isAllowedContainer("mov,mp4,m4a,3gp,3g2,mj2"), true)
  assert.equal(isAllowedContainer("matroska,webm"), true)
  assert.equal(isAllowedContainer("avi"), true)
  for (const bad of ["hls", "concat", "image2", "lavfi", "", undefined, "hls,applehttp"]) assert.equal(isAllowedContainer(bad), false, String(bad))
})

/* ── Haqiqiy ffmpeg bilan (o'rnatilmagan bo'lsa — o'tkazib yuboriladi) ── */
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0

test("ffprobe: g'alati belgili fayl nomi buyruq sifatida bajarilmaydi; HLS playlist rad etiladi", { skip: !hasFfmpeg && "ffmpeg yo'q" }, async () => {
  const dir = path.join(STORAGE, "ffmpeg-test")
  fs.mkdirSync(dir, { recursive: true })
  const sample = path.join(dir, "sample.mp4")
  const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=5", "-pix_fmt", "yuv420p", sample])
  assert.equal(made.status, 0)

  // Windows'da ham ruxsat etilgan, shell'da esa maxsus ma'noli belgilar
  const evilName = path.join(dir, "a;b&c$(touch PWNED)`id`.mp4")
  fs.copyFileSync(sample, evilName)
  const ok = await probe(evilName)
  assert.ok(ok, "oddiy video o'qilishi kerak")
  assert.ok(ok!.streams.some((s) => s.codec_type === "video"))
  assert.equal(fs.existsSync(path.join(dir, "PWNED")), false)
  assert.equal(fs.existsSync(path.join(process.cwd(), "PWNED")), false)

  // ".m3u8" va ".mp4" niqobidagi HLS playlist — boshqa faylni o'qitishga urinish
  const secret = path.join(dir, "secret.txt")
  fs.writeFileSync(secret, "maxfiy")
  const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${secret}\n#EXT-X-ENDLIST\n`
  for (const name of ["evil.m3u8", "evil.mp4"]) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, playlist)
    assert.equal(await probe(file), null, name)
  }

  // concat ro'yxati
  const concat = path.join(dir, "concat.mp4")
  fs.writeFileSync(concat, `ffconcat version 1.0\nfile '${sample.replace(/\\/g, "/")}'\n`)
  assert.equal(await probe(concat), null)
})
