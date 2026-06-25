const { execSync, execFileSync } = require("child_process")
const { platform } = require("os")

function isInstalled() {
  const bins =
    process.platform === "win32"
      ? ["C:\\Program Files\\LibreOffice\\program\\soffice.exe"]
      : ["libreoffice", "soffice"]

  for (const bin of bins) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" })
      return bin
    } catch {}
  }
  return null
}

const existing = isInstalled()
if (existing) {
  console.log(`✓ LibreOffice already installed (${existing})`)
  process.exit(0)
}

console.log("LibreOffice topilmadi. O'rnatilmoqda...\n")

if (process.platform === "win32") {
  // Windows 11 — winget (built-in)
  console.log("Windows: winget orqali o'rnatilmoqda...")
  console.log("Bu 2-3 daqiqa olishi mumkin...\n")
  try {
    execSync("winget install --id TheDocumentFoundation.LibreOffice -e --accept-package-agreements --accept-source-agreements", {
      stdio: "inherit",
    })
    console.log("\n✓ LibreOffice o'rnatildi!")
    console.log("  Backend serverini qayta ishga tushiring: npm run dev")
  } catch (e) {
    console.error("\n✗ winget orqali o'rnatib bo'lmadi.")
    console.log("  Qo'lda o'rnating: https://www.libreoffice.org/download/libreoffice-fresh/")
    process.exit(1)
  }
} else if (process.platform === "linux") {
  // Linux server (Ubuntu / Debian)
  console.log("Linux: apt-get orqali o'rnatilmoqda...")
  console.log("Bu 3-5 daqiqa olishi mumkin...\n")
  try {
    execSync("apt-get update -qq && apt-get install -y libreoffice --no-install-recommends", {
      stdio: "inherit",
    })
    console.log("\n✓ LibreOffice o'rnatildi!")
    console.log("  Backend serverini qayta ishga tushiring: npm run dev")
  } catch (e) {
    // Try with sudo
    try {
      execSync("sudo apt-get update -qq && sudo apt-get install -y libreoffice --no-install-recommends", {
        stdio: "inherit",
      })
      console.log("\n✓ LibreOffice o'rnatildi!")
    } catch (e2) {
      console.error("\n✗ O'rnatib bo'lmadi. Quyidagi buyruqni o'zingiz ishga tushiring:")
      console.log("  sudo apt-get install -y libreoffice --no-install-recommends")
      process.exit(1)
    }
  }
} else if (process.platform === "darwin") {
  // macOS — brew
  console.log("macOS: brew orqali o'rnatilmoqda...")
  try {
    execSync("brew install --cask libreoffice", { stdio: "inherit" })
    console.log("\n✓ LibreOffice o'rnatildi!")
  } catch {
    console.error("\n✗ O'rnatib bo'lmadi. Quyidagini ishga tushiring:")
    console.log("  brew install --cask libreoffice")
    process.exit(1)
  }
} else {
  console.log("Platformangiz aniqlashtirilmadi. Qo'lda o'rnating:")
  console.log("  https://www.libreoffice.org/download/libreoffice-fresh/")
  process.exit(1)
}
