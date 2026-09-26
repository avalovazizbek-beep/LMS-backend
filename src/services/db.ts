import mysql from "mysql2/promise"

export const DB_NAME = process.env.DB_NAME || "lms_portal"

const baseConfig = {
  host:     process.env.DB_HOST || "127.0.0.1",
  port:     Number(process.env.DB_PORT || 3306),
  user:     process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
}

export const pool = mysql.createPool({
  ...baseConfig,
  database: DB_NAME,
  waitForConnections: true,
  // Avval 10 edi — 800-1000 talaba bir vaqtda login qilganda (masalan
  // imtihon boshlanishida) bu havza o'zi tirbandlik nuqtasiga aylanib
  // qolardi. HEMIS bilan bog'liq muammo bartaraf etilgan taqdirda ham,
  // MySQL ulanish havzasi buning uchun yetarli bo'lishi kerak.
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 50),
  maxIdle:          Number(process.env.DB_MAX_IDLE || 10),
  idleTimeout:      60_000,
  enableKeepAlive:  true,
})

async function exec(sql: string) {
  await pool.query(sql)
}

// Xatolikni log qilib, davom etadi (CREATE TABLE uchun)
async function execSafe(sql: string, label?: string) {
  try {
    await pool.query(sql)
  } catch (err) {
    console.warn(`[DB] ${label ?? "execSafe"} xatolik (o'tkazib yuborildi):`, (err as { message?: string })?.message ?? err)
  }
}

// ALTER TABLE ... ADD COLUMN/INDEX ni qayta ishga tushirilganda xato bermasligi
// uchun "ustun/indeks allaqachon mavjud" xatoliklarini e'tiborsiz qoldiradi.
async function execIgnoreDuplicate(sql: string) {
  try {
    await pool.query(sql)
  } catch (err) {
    const code = (err as { code?: string })?.code
    if (code !== "ER_DUP_FIELDNAME" && code !== "ER_DUP_KEYNAME") throw err
  }
}

/* ── Schema ─────────────────────────────────────────────────────────── */
export async function initDatabase() {
  const server = await mysql.createConnection(baseConfig)
  await server.query(
    `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  )
  await server.end()

  // ── HEMIS user cache ──
  await exec(`
    CREATE TABLE IF NOT EXISTS hemis_users (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      hemis_id    VARCHAR(255) NOT NULL,
      role        VARCHAR(50)  NOT NULL DEFAULT 'student',
      username    VARCHAR(255),
      full_name   VARCHAR(255),
      hemis_token VARCHAR(2000),
      profile     LONGTEXT,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hemis_id (hemis_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // o'qituvchi raqamli ID (teacherUserId → lms_teacher_content.teacher_user_id bilan mos)
  await execIgnoreDuplicate(`ALTER TABLE hemis_users ADD COLUMN teacher_user_id INT NULL`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_users ADD INDEX idx_hemis_teacher_user_id (teacher_user_id)`)

  // Login+parol keshi: fon rejimida (JWT muddati tugaganda) foydalanuvchidan
  // qayta so'ramasdan HEMIS'dan yangi token olish uchun. Parol AES-256-GCM
  // bilan shifrlangan holda saqlanadi (services/credentialCrypto.ts) — hech
  // qachon oddiy matnda emas.
  await execIgnoreDuplicate(`ALTER TABLE hemis_users ADD COLUMN hemis_login VARCHAR(255) NULL AFTER username`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_users ADD COLUMN password_enc VARCHAR(1000) NULL AFTER hemis_login`)
  // Qaytgan foydalanuvchini login bo'yicha tez topish uchun — lokal
  // parol tekshiruvi (routes/hemis.ts, tryLocalStudentLogin) shu orqali ishlaydi.
  await execIgnoreDuplicate(`ALTER TABLE hemis_users ADD INDEX idx_hemis_users_login (hemis_login)`)

  // ── HEMIS API response cache ──
  await exec(`
    CREATE TABLE IF NOT EXISTS hemis_cache (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      user_id    VARCHAR(255) NOT NULL,
      cache_key  VARCHAR(500) NOT NULL,
      data       LONGTEXT     NOT NULL,
      cached_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP    NULL,
      UNIQUE KEY uq_user_key (user_id, cache_key(250))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Face ID ──
  await exec(`
    CREATE TABLE IF NOT EXISTS face_registrations (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(255) NOT NULL,
      display_name  VARCHAR(255),
      descriptors   LONGTEXT     NOT NULL,
      registered_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_face_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS face_requests (
      id          VARCHAR(36)   PRIMARY KEY,
      username    VARCHAR(255)  NOT NULL,
      reason      TEXT,
      status      ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
      admin_note  VARCHAR(1000) NOT NULL DEFAULT '',
      created_at  BIGINT        NOT NULL,
      reviewed_at BIGINT        NULL,
      INDEX idx_face_req_username (username),
      INDEX idx_face_req_status   (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  // Admin talabalar ro'yxatidan ko'rib, "Face ID eskirgan/noto'g'ri bo'lishi
  // mumkin" deb bevosita so'rov yuborishi mumkin — bu holda talaba hech
  // qanday ariza yubormasdan, to'g'ridan-to'g'ri 'approved' holatida boshlanadi
  // (pastdagi POST /admin/hemis-students/:hemisId/request-face-reregister).
  // Ikkala oqim ham bir xil status ustunidan foydalanadi, faqat kelib
  // chiqishi (kim boshlagani) frontendda qaysi xabar ko'rsatilishini aniqlaydi.
  await execIgnoreDuplicate(`ALTER TABLE face_requests ADD COLUMN initiated_by ENUM('student','admin') NOT NULL DEFAULT 'student' AFTER reason`)

  // ── Meeting users ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_groups (
      id         INT PRIMARY KEY,
      name       VARCHAR(120) NOT NULL,
      direction  VARCHAR(255) NULL,
      course     INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_users (
      id         INT PRIMARY KEY,
      full_name  VARCHAR(255) NOT NULL,
      role       ENUM('admin','teacher','student') NOT NULL,
      group_id   INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_meeting_users_group (group_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_teacher_groups (
      user_id  INT NOT NULL,
      group_id INT NOT NULL,
      PRIMARY KEY (user_id, group_id),
      INDEX idx_teacher_groups_group (group_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_teacher_subjects (
      user_id      INT NOT NULL,
      subject_name VARCHAR(255) NOT NULL,
      PRIMARY KEY (user_id, subject_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Meetings ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meetings (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      title             VARCHAR(255) NOT NULL,
      description       TEXT NULL,
      created_by_user_id INT NOT NULL,
      start_time        DATETIME NOT NULL,
      end_time          DATETIME NOT NULL,
      status            ENUM('scheduled','live','ended','cancelled') NOT NULL DEFAULT 'scheduled',
      settings_json     JSON NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_meetings_status_time (status, start_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_groups (
      meeting_id INT NOT NULL,
      group_id   INT NOT NULL,
      PRIMARY KEY (meeting_id, group_id),
      INDEX idx_meeting_groups_group (group_id),
      CONSTRAINT fk_mg_meeting FOREIGN KEY (meeting_id) REFERENCES lms_meetings(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_attendance (
      id                      INT AUTO_INCREMENT PRIMARY KEY,
      meeting_id              INT NOT NULL,
      user_id                 INT NOT NULL,
      group_id                INT NULL,
      full_name               VARCHAR(255) NOT NULL,
      face_visible_seconds    INT NOT NULL DEFAULT 0,
      synced_to_main_backend  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_attendance_user (meeting_id, user_id),
      CONSTRAINT fk_att_meeting FOREIGN KEY (meeting_id) REFERENCES lms_meetings(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await execIgnoreDuplicate(`ALTER TABLE lms_meeting_attendance ADD COLUMN face_visible_seconds INT NOT NULL DEFAULT 0 AFTER full_name`)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_attendance_sessions (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      attendance_id INT NOT NULL,
      joined_at     DATETIME NULL,
      left_at       DATETIME NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_att_sessions_att (attendance_id),
      CONSTRAINT fk_sess_att FOREIGN KEY (attendance_id) REFERENCES lms_meeting_attendance(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_subject_resources (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      uuid              CHAR(36) NOT NULL,
      subject_id        VARCHAR(100) NULL,
      subject_name      VARCHAR(255) NOT NULL,
      title             VARCHAR(255) NOT NULL,
      comment           TEXT NULL,
      kind              ENUM('lecture','presentation','laboratory','video_lesson','meeting_video','other') NOT NULL,
      training_type_name VARCHAR(120) NOT NULL,
      employee_name     VARCHAR(255) NULL,
      meeting_id        INT NULL,
      file_name         VARCHAR(255) NOT NULL,
      original_name     VARCHAR(255) NOT NULL,
      mime_type         VARCHAR(120) NOT NULL,
      file_size         BIGINT NOT NULL,
      relative_path     VARCHAR(500) NOT NULL,
      public_url        VARCHAR(500) NOT NULL,
      external_url      VARCHAR(1000) NULL,
      is_active         TINYINT(1) NOT NULL DEFAULT 1,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_resource_uuid (uuid),
      INDEX idx_resources_subject (subject_name),
      INDEX idx_resources_kind (kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await execIgnoreDuplicate(`ALTER TABLE lms_subject_resources ADD COLUMN external_url VARCHAR(1000) NULL AFTER public_url`)
  await execIgnoreDuplicate(`ALTER TABLE lms_subject_resources ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER external_url`)

  // ── O'qituvchi dars jadvali (HEMIS'dan sinxronlangan, faqat o'qish uchun) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_teacher_schedule (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      teacher_user_id   INT NOT NULL,
      group_id          INT NULL,
      subject_name      VARCHAR(255) NOT NULL,
      week_day          VARCHAR(20) NULL,
      lesson_date       DATE NULL,
      start_time        VARCHAR(10) NULL,
      end_time          VARCHAR(10) NULL,
      room              VARCHAR(120) NULL,
      raw_json          JSON NULL,
      synced_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_teacher_schedule_teacher (teacher_user_id),
      INDEX idx_teacher_schedule_group (group_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── O'qituvchi yuklagan kontent (darslik / topshiriq / imtihon / mavzu / ...) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_teacher_content (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      uuid              CHAR(36) NOT NULL,
      type              ENUM('lesson','assignment','exam','mavzu','kurs-topshiriq','kalendar','malumot') NOT NULL,
      teacher_user_id   INT NOT NULL,
      group_id          INT NOT NULL,
      subject_name      VARCHAR(255) NOT NULL,
      title             VARCHAR(255) NOT NULL,
      description       TEXT NULL,
      kind              VARCHAR(40) NULL,
      file_name         VARCHAR(255) NULL,
      original_name     VARCHAR(255) NULL,
      mime_type         VARCHAR(120) NULL,
      file_size         BIGINT NULL,
      relative_path     VARCHAR(500) NULL,
      public_url        VARCHAR(500) NULL,
      available_from    DATETIME NOT NULL,
      deadline          DATETIME NULL,
      max_score         INT NULL,
      duration_minutes  INT NULL,
      training_load     INT NULL,
      lesson_date       DATE NULL,
      delivered         TINYINT(1) NOT NULL DEFAULT 0,
      is_active         TINYINT(1) NOT NULL DEFAULT 1,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_teacher_content_uuid (uuid),
      INDEX idx_teacher_content_teacher (teacher_user_id),
      INDEX idx_teacher_content_group (group_id),
      INDEX idx_teacher_content_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // Eski o'rnatishlarda type ENUM va yangi ustunlarni qo'shib qo'yish
  await execIgnoreDuplicate(`
    ALTER TABLE lms_teacher_content
      MODIFY COLUMN type ENUM('lesson','assignment','exam','mavzu','kurs-topshiriq','kalendar','malumot') NOT NULL
  `)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN training_load INT NULL AFTER duration_minutes`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN lesson_date DATE NULL AFTER training_load`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN delivered TINYINT(1) NOT NULL DEFAULT 0 AFTER lesson_date`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER delivered`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN resource_type VARCHAR(40) NULL AFTER kind`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN meeting_link VARCHAR(500) NULL AFTER public_url`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN control_type VARCHAR(60) NULL AFTER kind`)
  // Mashg'ulot turi — Ma'ruza / Amaliyot / Mustaqil ish (video/audio/theory/qollanma/assignment kabi resurslar uchun)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN training_type VARCHAR(40) NULL AFTER kind`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN attempts_count INT NULL AFTER max_score`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN question_display_count INT NULL AFTER attempts_count`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN language VARCHAR(20) NULL AFTER question_display_count`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN topic_key VARCHAR(255) NULL AFTER subject_name`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD INDEX idx_teacher_content_topic_key (topic_key)`)
  // Mavzuni "qayta ochish" — deadline'dan keyin ham shu mavzudagi test/topshiriqni
  // qayta topshirishga ruxsat berish (o'qituvchi: faqat deadline'gacha, admin: istalgan vaqt)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN is_reopened TINYINT(1) NOT NULL DEFAULT 0 AFTER is_active`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN reopened_by VARCHAR(255) NULL AFTER is_reopened`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN reopened_at TIMESTAMP NULL AFTER reopened_by`)

  // ── O'qituvchi yuklagan kontentga biriktirilgan qo'shimcha fayllar (bir nechta) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_teacher_content_files (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      content_id        INT NOT NULL,
      file_name         VARCHAR(255) NOT NULL,
      original_name     VARCHAR(255) NOT NULL,
      mime_type         VARCHAR(120) NULL,
      file_size         BIGINT NULL,
      relative_path     VARCHAR(500) NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_content_files_content (content_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Davomat (qo'lda, o'qituvchi tomonidan belgilanadi) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_attendance (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      group_id          INT NOT NULL,
      subject_name      VARCHAR(255) NOT NULL,
      lesson_date       DATE NOT NULL,
      student_user_id   INT NOT NULL,
      student_full_name VARCHAR(255) NOT NULL,
      status            ENUM('present','absent','excused','late') NOT NULL DEFAULT 'absent',
      comment           TEXT NULL,
      marked_by_user_id INT NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_attendance (group_id, subject_name, lesson_date, student_user_id),
      INDEX idx_attendance_group_date (group_id, lesson_date),
      INDEX idx_attendance_student (student_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await execIgnoreDuplicate(`ALTER TABLE lms_attendance ADD COLUMN training_type VARCHAR(60) NULL AFTER lesson_date`)

  // ── Zoom integratsiyasi — har bir o'qituvchi o'z Zoom hisobini ulaydi ──
  await exec(`
    CREATE TABLE IF NOT EXISTS zoom_connections (
      id                      INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id              INT NOT NULL,
      zoom_user_id            VARCHAR(128) NOT NULL,
      zoom_account_id         VARCHAR(128) NULL,
      zoom_email              VARCHAR(255) NULL,
      access_token_encrypted  TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      token_expires_at        DATETIME NOT NULL,
      scope                   VARCHAR(500) NULL,
      status                  ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
      created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_zoom_teacher (teacher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_zoom (
      id                       INT AUTO_INCREMENT PRIMARY KEY,
      meeting_id               INT NOT NULL,
      teacher_id               INT NOT NULL,
      zoom_meeting_id          VARCHAR(64) NULL,
      zoom_join_url            TEXT NULL,
      zoom_start_url_encrypted TEXT NULL,
      zoom_password            VARCHAR(50) NULL,
      status                   ENUM('pending','created','failed') NOT NULL DEFAULT 'pending',
      error_code               VARCHAR(100) NULL,
      error_message            TEXT NULL,
      created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_meeting_zoom (meeting_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // Avval "Zoomni uzish" faqat status='revoked' qo'yardi — shifrlangan
  // tokenlar va Zoom email bazada qolardi. Endi uzishda o'chiriladi;
  // eski qoldiqlarni bir marta tozalaymiz (keyingi ishga tushishlarda bo'sh).
  await execSafe(`
    UPDATE lms_meeting_zoom SET zoom_start_url_encrypted = NULL
    WHERE teacher_id IN (SELECT teacher_id FROM zoom_connections WHERE status = 'revoked')
  `, "zoom revoked cleanup (start_url)")
  await execSafe(`DELETE FROM zoom_connections WHERE status = 'revoked'`, "zoom revoked cleanup")

  await exec(`
    CREATE TABLE IF NOT EXISTS google_meet_connections (
      id                      INT AUTO_INCREMENT PRIMARY KEY,
      teacher_id              INT NOT NULL,
      google_user_id          VARCHAR(128) NOT NULL,
      google_email            VARCHAR(255) NULL,
      access_token_encrypted  TEXT NOT NULL,
      refresh_token_encrypted TEXT NOT NULL,
      token_expires_at        DATETIME NOT NULL,
      scope                   VARCHAR(500) NULL,
      status                  ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
      created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_google_meet_teacher (teacher_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_google_meet (
      id                       INT AUTO_INCREMENT PRIMARY KEY,
      meeting_id               INT NOT NULL,
      teacher_id               INT NOT NULL,
      google_space_name        VARCHAR(255) NULL,
      google_meeting_uri       TEXT NULL,
      google_meeting_code      VARCHAR(50) NULL,
      status                   ENUM('pending','created','failed') NOT NULL DEFAULT 'pending',
      error_code               VARCHAR(100) NULL,
      error_message            TEXT NULL,
      created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_meeting_google_meet (meeting_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Murojaatlar (talaba -> o'qituvchi/dekanat/admin, 1:1 suhbat) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_conversations (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      student_user_id     INT NOT NULL,
      student_name        VARCHAR(255) NOT NULL,
      student_group_id    INT NULL,
      student_group_name  VARCHAR(255) NULL,
      student_phone       VARCHAR(50) NULL,
      student_id_number   VARCHAR(100) NULL,
      recipient_type      ENUM('teacher','dean','admin') NOT NULL,
      recipient_user_id   INT NULL,
      recipient_name      VARCHAR(255) NULL,
      subject             VARCHAR(255) NOT NULL,
      status              ENUM('open','closed') NOT NULL DEFAULT 'open',
      closed_by_name      VARCHAR(255) NULL,
      created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at           TIMESTAMP NULL,
      last_message_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conv_student (student_user_id),
      INDEX idx_conv_recipient (recipient_type, recipient_user_id),
      INDEX idx_conv_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_conversation_messages (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      conversation_id  INT NOT NULL,
      sender_user_id   INT NOT NULL,
      sender_name      VARCHAR(255) NOT NULL,
      sender_role      ENUM('student','teacher','dean','admin') NOT NULL,
      body             TEXT NULL,
      attachment_path  VARCHAR(500) NULL,
      attachment_name  VARCHAR(255) NULL,
      attachment_mime  VARCHAR(100) NULL,
      attachment_size  INT NULL,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_msg_conv (conversation_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Baholar (qo'lda, o'qituvchi tomonidan qo'yiladi) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_grades (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      group_id          INT NOT NULL,
      subject_name      VARCHAR(255) NOT NULL,
      lesson_date       DATE NOT NULL,
      student_user_id   INT NOT NULL,
      student_full_name VARCHAR(255) NOT NULL,
      grade             INT NULL,
      comment           TEXT NULL,
      marked_by_user_id INT NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_grades (group_id, subject_name, lesson_date, student_user_id),
      INDEX idx_grades_group_date (group_id, lesson_date),
      INDEX idx_grades_student (student_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Talaba topshirgan ishlari (topshiriq va imtihon uchun umumiy) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_submissions (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      content_id          INT NOT NULL,
      student_user_id     INT NOT NULL,
      student_full_name   VARCHAR(255) NOT NULL,
      group_id            INT NULL,
      file_name           VARCHAR(255) NULL,
      original_name       VARCHAR(255) NULL,
      mime_type           VARCHAR(120) NULL,
      file_size           BIGINT NULL,
      relative_path       VARCHAR(500) NULL,
      public_url          VARCHAR(500) NULL,
      comment             TEXT NULL,
      submitted_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      grade               INT NULL,
      feedback            TEXT NULL,
      graded_at           TIMESTAMP NULL,
      graded_by_user_id   INT NULL,
      UNIQUE KEY uq_submission_content_student (content_id, student_user_id),
      INDEX idx_submissions_content (content_id),
      CONSTRAINT fk_submission_content FOREIGN KEY (content_id) REFERENCES lms_teacher_content(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Imtihon savollari (MCQ) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_exam_questions (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      content_id    INT NOT NULL,
      question_text TEXT NOT NULL,
      options       JSON NOT NULL,
      correct_index INT NOT NULL,
      points        INT NOT NULL DEFAULT 1,
      order_index   INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_exam_questions_content (content_id),
      CONSTRAINT fk_exam_questions_content FOREIGN KEY (content_id) REFERENCES lms_teacher_content(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── lms_exam_questions yangi ustunlari ──
  await execIgnoreDuplicate(`ALTER TABLE lms_exam_questions ADD COLUMN image_url VARCHAR(2048) NULL`)
  await execIgnoreDuplicate(`ALTER TABLE lms_exam_questions ADD COLUMN correct_indexes JSON NULL`)
  await execIgnoreDuplicate(`ALTER TABLE lms_exam_questions ADD COLUMN option_images JSON NULL`)
  // Moslashuvchan (adaptive) test uchun savol qiyinlik darajasi
  await execIgnoreDuplicate(`ALTER TABLE lms_exam_questions ADD COLUMN difficulty ENUM('oson','orta','qiyin') NOT NULL DEFAULT 'orta'`)

  // ── lms_teacher_content: resurs uchun ball + test sozlamalari ──
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN completion_points INT NULL DEFAULT NULL`)
  // Moslashuvchan test: talaba javobiga qarab keyingi savol qiyinligi moslashadi
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN is_adaptive TINYINT(1) NOT NULL DEFAULT 0 AFTER language`)

  // ── Talaba progress: video/audio pozitsiyasi va hujjat sahifalari ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_content_progress (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      content_id            INT NOT NULL,
      student_user_id       INT NOT NULL,
      max_position_seconds  INT NOT NULL DEFAULT 0,
      duration_seconds      INT NULL,
      pages_read            TEXT NULL,
      total_pages           INT NULL,
      completed             TINYINT(1) NOT NULL DEFAULT 0,
      completed_at          TIMESTAMP NULL,
      updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_progress_content_student (content_id, student_user_id),
      CONSTRAINT fk_progress_content FOREIGN KEY (content_id) REFERENCES lms_teacher_content(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── lms_submissions: avtomatik baholangan imtihon javoblari uchun ustunlar ──
  await ensureColumn("lms_submissions", "answers", "JSON NULL")
  await ensureColumn("lms_submissions", "auto_graded", "TINYINT(1) NOT NULL DEFAULT 0")
  await ensureColumn("lms_submissions", "attempts_used", "INT NOT NULL DEFAULT 1")
  await ensureColumn("lms_submissions", "question_ids", "TEXT NULL DEFAULT NULL")
  await ensureColumn("lms_submissions", "option_perms", "TEXT NULL DEFAULT NULL")
  // Antiplagiat: fayl/izohdan ajratib olingan matn — LibreOffice orqali bir marta
  // ajratilib keshlanadi (har safar qayta konvertatsiya qilinmasligi uchun)
  await ensureColumn("lms_submissions", "extracted_text", "MEDIUMTEXT NULL DEFAULT NULL")

  // ── lms_meetings: fan nomi (subjectName) ──
  await ensureColumn("lms_meetings", "subject_name", "VARCHAR(255) NULL")

  // ── HEMIS topshiriqlari (vaqtinchalik — keyin HEMIS ga yuboriladi) ──
  // ── Platform sessiyalari (kirish/chiqish vaqtini kuzatish) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_platform_sessions (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      user_id       INT NOT NULL,
      full_name     VARCHAR(255) NOT NULL,
      group_id      INT NULL,
      role          VARCHAR(50) NOT NULL DEFAULT 'student',
      login_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      logout_at     TIMESTAMP NULL,
      INDEX idx_pses_user_date  (user_id, login_at),
      INDEX idx_pses_group_date (group_id, login_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_hemis_task_submissions (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      hemis_task_id     VARCHAR(191) NOT NULL,
      student_user_id   INT NOT NULL,
      student_full_name VARCHAR(255) NOT NULL,
      group_id          INT NULL,
      file_name         VARCHAR(255) NULL,
      original_name     VARCHAR(255) NULL,
      mime_type         VARCHAR(120) NULL,
      file_size         BIGINT NULL,
      relative_path     VARCHAR(500) NULL,
      comment           TEXT NULL,
      submitted_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_hemis_task_student (hemis_task_id, student_user_id),
      INDEX idx_hemis_sub_task (hemis_task_id),
      INDEX idx_hemis_sub_student (student_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_hemis_task_submissions")

  // ── Meeting yozuvlari (recording) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_meeting_recordings (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      meeting_id          INT NOT NULL,
      file_name           VARCHAR(255) NOT NULL,
      original_name       VARCHAR(255) NOT NULL,
      mime_type           VARCHAR(100) NOT NULL,
      file_size           BIGINT NOT NULL,
      relative_path       VARCHAR(500) NOT NULL,
      recorded_by_user_id INT NOT NULL,
      created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_recordings_meeting (meeting_id),
      CONSTRAINT fk_recordings_meeting FOREIGN KEY (meeting_id) REFERENCES lms_meetings(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Davriy baholar: ON1, ON2, YN (o'qituvchi qo'lda kiritadi) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_period_grades (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      group_id        INT NOT NULL,
      subject_name    VARCHAR(255) NOT NULL,
      student_user_id INT NOT NULL,
      grade_type      VARCHAR(20) NOT NULL,
      grade           DECIMAL(5,1) NULL,
      teacher_user_id INT NOT NULL,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_period_grade (group_id, subject_name, student_user_id, grade_type),
      INDEX idx_period_grades_group (group_id, subject_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_period_grades")

  // ── Imtihon sessiyasi: talabaga ko'rsatilgan savollar tartibini saqlaydi ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_exam_sessions (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      content_id        INT NOT NULL,
      student_user_id   INT NOT NULL,
      question_ids      TEXT NOT NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_exam_session (content_id, student_user_id),
      INDEX idx_exam_session_student (student_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)
  await ensureColumn("lms_exam_sessions", "option_perms", "TEXT NULL DEFAULT NULL")
  // Moslashuvchan test uchun: javob berilgan savollar, to'g'ri/xato va joriy qiyinlik darajasi (JSON)
  await ensureColumn("lms_exam_sessions", "adaptive_state", "TEXT NULL DEFAULT NULL")

  // ── Imtihon paytidagi buzilishlar (fullscreen'dan chiqish, oynadan chalg'ish,
  // Face ID mos kelmasligi) — talaba tomonidan avtomatik yuboriladi, o'qituvchi/admin ko'radi ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_exam_violations (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      content_id        INT NOT NULL,
      student_user_id   INT NOT NULL,
      student_full_name VARCHAR(255) NOT NULL,
      group_id          INT NULL,
      violation_type    VARCHAR(40) NOT NULL,
      detail            VARCHAR(255) NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_exam_violations_content (content_id, student_user_id),
      CONSTRAINT fk_exam_violations_content FOREIGN KEY (content_id) REFERENCES lms_teacher_content(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_exam_violations")

  // ── Imtihonni qayta topshirish ruxsati: admin tomonidan yiqilgan talabaga beriladi ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_exam_retake_grants (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      content_id        INT NOT NULL,
      student_user_id   INT NOT NULL,
      status            ENUM('active','used','revoked') NOT NULL DEFAULT 'active',
      granted_by        VARCHAR(255) NULL,
      reason            VARCHAR(500) NULL,
      granted_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      used_at           TIMESTAMP NULL,
      revoked_at        TIMESTAMP NULL,
      INDEX idx_retake_content_student (content_id, student_user_id, status),
      CONSTRAINT fk_retake_content FOREIGN KEY (content_id) REFERENCES lms_teacher_content(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_exam_retake_grants")

  // ── Qayta o'qish (reedu): HEMIS'da fandan umumiy ball 55dan past chiqqan
  // (retraining_status=true) talabani maxsus "reedu" guruhga biriktirib,
  // jadval/davomat/nazoratni oxirigacha LMS ichida yuritish uchun ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_reedu_groups (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      name              VARCHAR(255) NOT NULL,
      subject_name      VARCHAR(255) NOT NULL,
      teacher_user_id   INT NULL,
      teacher_full_name VARCHAR(255) NULL,
      semester          VARCHAR(20) NULL,
      status            ENUM('active','closed') NOT NULL DEFAULT 'active',
      created_by        VARCHAR(255) NULL,
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reedu_groups_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_reedu_groups")

  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_reedu_enrollments (
      id                   INT AUTO_INCREMENT PRIMARY KEY,
      reedu_group_id       INT NOT NULL,
      student_user_id      INT NOT NULL,
      student_full_name    VARCHAR(255) NOT NULL,
      student_id_number    VARCHAR(100) NULL,
      subject_name         VARCHAR(255) NOT NULL,
      original_group_id    INT NOT NULL,
      original_group_name  VARCHAR(255) NULL,
      semester             VARCHAR(20) NULL,
      debtor_total_point   DECIMAL(6,2) NULL,
      status               ENUM('active','completed','failed') NOT NULL DEFAULT 'active',
      final_score          DECIMAL(6,2) NULL,
      created_by           VARCHAR(255) NULL,
      created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at         TIMESTAMP NULL,
      UNIQUE KEY uq_reedu_enrollment (reedu_group_id, student_user_id, subject_name),
      INDEX idx_reedu_enroll_student (student_user_id),
      CONSTRAINT fk_reedu_enroll_group FOREIGN KEY (reedu_group_id) REFERENCES lms_reedu_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_reedu_enrollments")

  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_reedu_schedule (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      reedu_group_id INT NOT NULL,
      week_day       TINYINT NOT NULL,
      start_time     VARCHAR(10) NOT NULL,
      end_time       VARCHAR(10) NOT NULL,
      room           VARCHAR(120) NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_reedu_schedule_group (reedu_group_id),
      CONSTRAINT fk_reedu_sched_group FOREIGN KEY (reedu_group_id) REFERENCES lms_reedu_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_reedu_schedule")

  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_reedu_attendance (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      reedu_group_id  INT NOT NULL,
      student_user_id INT NOT NULL,
      lesson_date     DATE NOT NULL,
      status          ENUM('present','absent','late','excused') NOT NULL DEFAULT 'present',
      marked_by       VARCHAR(255) NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reedu_att (reedu_group_id, student_user_id, lesson_date),
      INDEX idx_reedu_att_group_date (reedu_group_id, lesson_date),
      CONSTRAINT fk_reedu_att_group FOREIGN KEY (reedu_group_id) REFERENCES lms_reedu_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_reedu_attendance")

  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_reedu_grades (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      reedu_group_id  INT NOT NULL,
      student_user_id INT NOT NULL,
      grade_type      ENUM('JN','ON1','ON2','YN') NOT NULL,
      grade           DECIMAL(5,1) NULL,
      updated_by      VARCHAR(255) NULL,
      updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_reedu_grade (reedu_group_id, student_user_id, grade_type),
      CONSTRAINT fk_reedu_grade_group FOREIGN KEY (reedu_group_id) REFERENCES lms_reedu_groups(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_reedu_grades")

  // ── Antiplagiat: talaba-talaba (matn shingling/Jaccard) va internet
  // qidiruv natijalari — har bir topshiriq uchun keshlanadi ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_plagiarism_checks (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      content_id            INT NOT NULL,
      submission_id         INT NOT NULL,
      student_user_id       INT NOT NULL,
      student_full_name     VARCHAR(255) NOT NULL,
      max_similarity_pct    DECIMAL(5,2) NOT NULL DEFAULT 0,
      matched_submission_id INT NULL,
      matched_student_name  VARCHAR(255) NULL,
      internet_enabled      TINYINT(1) NOT NULL DEFAULT 0,
      internet_matches      JSON NULL,
      checked_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_plag_submission (submission_id),
      INDEX idx_plag_content (content_id),
      CONSTRAINT fk_plag_content FOREIGN KEY (content_id) REFERENCES lms_teacher_content(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_plagiarism_checks")

  // ── Admin ruxsatnomalar: kimga qanday LMS roli berilgan ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_permissions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      hemis_id    VARCHAR(255) NOT NULL,
      full_name   VARCHAR(255),
      hemis_role  VARCHAR(100),
      lms_role    ENUM('admin','dean','teacher','student','blocked','pending') NOT NULL DEFAULT 'pending',
      granted_by  VARCHAR(255),
      granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      note        VARCHAR(500),
      UNIQUE KEY uq_perm_hemis_id (hemis_id),
      INDEX idx_perm_lms_role (lms_role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_permissions")
  // Eski o'rnatishlarda lms_role ENUM'ga 'dean' qo'shib qo'yish
  await execIgnoreDuplicate(`
    ALTER TABLE lms_permissions
      MODIFY COLUMN lms_role ENUM('admin','dean','teacher','student','blocked','pending') NOT NULL DEFAULT 'pending'
  `)

  // ── Kengaytirilgan boshqaruv: rol × modul bo'yicha Ko'rish/Yaratish/
  // Tahrirlash/O'chirish huquqlari (admin/dean uchun) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_role_permissions (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      role       VARCHAR(30) NOT NULL,
      module     VARCHAR(50) NOT NULL,
      can_view   TINYINT(1) NOT NULL DEFAULT 0,
      can_create TINYINT(1) NOT NULL DEFAULT 0,
      can_edit   TINYINT(1) NOT NULL DEFAULT 0,
      can_delete TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_role_module (role, module)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_role_permissions")

  // Standart qiymatlarni bir marta urug'lantirish (mavjud bo'lsa qayta yozilmaydi).
  // Modul nomlari kod ichida qat'iy belgilangan (foydalanuvchi kiritmaydi) — shu
  // sabab to'g'ridan-to'g'ri qatorga qo'shish xavfsiz.
  const ADMIN_MODULES = ["users", "students", "teachers", "results", "attendance", "grading", "retake", "reedu", "faceid", "announcements", "settings", "permissions"]
  for (const mod of ADMIN_MODULES) {
    await pool.query(
      `INSERT IGNORE INTO lms_role_permissions (role, module, can_view, can_create, can_edit, can_delete) VALUES ('admin', ?, 1, 1, 1, 1)`,
      [mod]
    )
    await pool.query(
      `INSERT IGNORE INTO lms_role_permissions (role, module, can_view, can_create, can_edit, can_delete) VALUES ('dean', ?, 1, 0, 0, 0)`,
      [mod]
    )
  }

  // ── Audit log: kim (IP bilan) qaysi admin amalini bajardi ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_audit_log (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      actor_hemis_id VARCHAR(255) NOT NULL,
      actor_name     VARCHAR(255) NULL,
      actor_role     VARCHAR(30) NULL,
      action         VARCHAR(100) NOT NULL,
      module         VARCHAR(50) NULL,
      target         VARCHAR(255) NULL,
      detail         JSON NULL,
      ip_address     VARCHAR(64) NULL,
      user_agent     VARCHAR(500) NULL,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_actor (actor_hemis_id),
      INDEX idx_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_audit_log")

  // ── Tizim sozlamalari (admin tomonidan o'zgartiriladigan) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_settings (
      key_name   VARCHAR(100) PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_settings")

  // ── E'lonlar (admin tomonidan yaratiladigan, talaba/xodim/hammaga mo'ljallangan) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_announcements (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      title               VARCHAR(255) NULL,
      message             TEXT NULL,
      audience            ENUM('student','employee','all') NOT NULL DEFAULT 'all',
      file_name           VARCHAR(255) NULL,
      original_name       VARCHAR(255) NULL,
      mime_type           VARCHAR(120) NULL,
      file_size           BIGINT NULL,
      relative_path       VARCHAR(500) NULL,
      media_kind          ENUM('image','video','file') NULL,
      is_active           TINYINT(1) NOT NULL DEFAULT 1,
      created_by_user_id  INT NOT NULL,
      created_by_name     VARCHAR(255) NULL,
      created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_announcements_audience_active (audience, is_active),
      INDEX idx_announcements_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // E'lonni foydalanuvchi tomonidan yopilgani — doimiy, shu user uchun bir marta
  // (is_active qayta yoqilganda ham qayta chiqmasligi uchun bu jadval TOZALANMAYDI)
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_announcement_dismissals (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      announcement_id INT NOT NULL,
      user_id         INT NOT NULL,
      dismissed_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_announcement_dismissal (announcement_id, user_id),
      INDEX idx_dismissal_user (user_id),
      CONSTRAINT fk_dismissal_announcement FOREIGN KEY (announcement_id)
        REFERENCES lms_announcements(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // Talaba va xodim ID'lari turli HEMIS jadvallaridan — raqam bir xil
  // bo'lishi mumkin (talaba 123 ≠ xodim 123). Yopish yozuvi rol bilan
  // saqlanadi, aks holda talaba yopgan e'lon shu raqamli xodimga ham
  // ko'rinmay qolardi. Eski yozuvlarda user_role = '' (ikkala rolga ham
  // tegishli deb hisoblanadi).
  await execIgnoreDuplicate(`ALTER TABLE lms_announcement_dismissals ADD COLUMN user_role VARCHAR(20) NOT NULL DEFAULT '' AFTER announcement_id`)
  await execIgnoreDuplicate(`ALTER TABLE lms_announcement_dismissals ADD UNIQUE KEY uq_announcement_dismissal_role (announcement_id, user_role, user_id)`)
  {
    const [oldKey] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'lms_announcement_dismissals' AND index_name = 'uq_announcement_dismissal'
       LIMIT 1`
    )
    if (oldKey.length) await exec(`ALTER TABLE lms_announcement_dismissals DROP INDEX uq_announcement_dismissal`)
  }

  // "Javob talab qilinsin" — xodimlarga e'lon: javob yozmaguncha yopilmaydi
  await execIgnoreDuplicate(`ALTER TABLE lms_announcements ADD COLUMN require_reply TINYINT(1) NOT NULL DEFAULT 0 AFTER audience`)

  await exec(`
    CREATE TABLE IF NOT EXISTS lms_announcement_replies (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      announcement_id INT NOT NULL,
      user_role       VARCHAR(20) NOT NULL,
      user_id         INT NOT NULL,
      full_name       VARCHAR(255) NULL,
      body            TEXT NOT NULL,
      created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_announcement_reply (announcement_id, user_role, user_id),
      INDEX idx_reply_announcement (announcement_id, created_at),
      CONSTRAINT fk_reply_announcement FOREIGN KEY (announcement_id)
        REFERENCES lms_announcements(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Bildirishnomalar (Xabarnomalar) — egasi (rol + ID) bo'yicha ──
  // Avval server xotirasida (massivda) turardi: qayta ishga tushganda
  // yo'qolardi, rol hisobga olinmasdi va hammaga ko'rinadigan demo yozuvlar
  // bor edi.
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_notifications (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      user_role   VARCHAR(20) NOT NULL,
      user_id     INT NOT NULL,
      type        VARCHAR(20) NOT NULL DEFAULT 'system',
      title       VARCHAR(255) NOT NULL,
      body        TEXT NULL,
      link        VARCHAR(500) NULL,
      i18n_key    VARCHAR(100) NULL,
      i18n_params JSON NULL,
      is_read     TINYINT(1) NOT NULL DEFAULT 0,
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_notifications_owner (user_role, user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── Demo/test hisoblar — login+parol bilan HEMIS'siz kirish (faqat sinov uchun) ──
  await exec(`
    CREATE TABLE IF NOT EXISTS lms_demo_accounts (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      username           VARCHAR(100) NOT NULL,
      password_hash      VARCHAR(255) NOT NULL,
      role               ENUM('student','employee') NOT NULL,
      hemis_id           INT NOT NULL,
      full_name          VARCHAR(255) NOT NULL,
      group_id           INT NULL,
      teacher_group_ids  JSON NULL,
      created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_demo_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

  // ── HEMIS to'liq talaba/xodim ro'yxati (fon rejimida sinxronlanadi,
  // services/hemisSync.ts) — login blokidan mustaqil, admin-token
  // (/v1/data/*) orqali oldindan olib qo'yiladi, shu bilan ro'yxatni
  // ko'rish HEMIS'ning login endpointiga umuman bog'liq bo'lmaydi ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_students_directory (
      hemis_id           INT PRIMARY KEY,
      full_name          VARCHAR(255) NOT NULL,
      student_id_number  VARCHAR(100) NULL,
      login              VARCHAR(255) NULL,
      group_id           INT NULL,
      group_name         VARCHAR(255) NULL,
      department         VARCHAR(255) NULL,
      is_active          TINYINT(1) NOT NULL DEFAULT 1,
      profile            LONGTEXT NULL,
      synced_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_students_dir_group (group_id),
      INDEX idx_students_dir_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_students_directory")
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER department`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD INDEX idx_students_dir_active (is_active)`)
  // Talabaning o'z yozuvida to'g'ridan-to'g'ri bor ekan (guruh/curriculum
  // orqali aylanib o'tish shart emas) — ta'lim shakli (Kunduzgi/Masofaviy/...),
  // daraja (Bakalavr/Magistr) va kurs (1-kurs, 2-kurs...). Admin panelda
  // "faqat masofaviy, N-kurs, Bakalavr/Magistr" filtri shu ustunlarga tayanadi.
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN education_form_code VARCHAR(20) NULL AFTER department`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN education_form_name VARCHAR(100) NULL AFTER education_form_code`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN education_type_code VARCHAR(20) NULL AFTER education_form_name`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN education_type_name VARCHAR(100) NULL AFTER education_type_code`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN level_code VARCHAR(20) NULL AFTER education_type_name`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD COLUMN level_name VARCHAR(100) NULL AFTER level_code`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_students_directory ADD INDEX idx_students_dir_form (education_form_code)`)

  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_employees_directory (
      hemis_id            INT PRIMARY KEY,
      full_name           VARCHAR(255) NOT NULL,
      employee_id_number  VARCHAR(100) NULL,
      login               VARCHAR(255) NULL,
      department          VARCHAR(255) NULL,
      position            VARCHAR(255) NULL,
      is_active           TINYINT(1) NOT NULL DEFAULT 1,
      profile              LONGTEXT NULL,
      synced_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_employees_dir_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_employees_directory")
  await execIgnoreDuplicate(`ALTER TABLE hemis_employees_directory ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER position`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_employees_directory ADD INDEX idx_employees_dir_active (is_active)`)

  // ── Fakultet/Kafedra (HEMIS'da bitta resurs — /v1/data/department-list,
  // structure_type orqali ajratiladi: "Fakultet", "Kafedra", "Bo'lim" va h.k.) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_departments_directory (
      hemis_id        INT PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      code            VARCHAR(100) NULL,
      parent_id       INT NULL,
      structure_type  VARCHAR(120) NULL,
      is_active       TINYINT(1) NOT NULL DEFAULT 1,
      profile         LONGTEXT NULL,
      synced_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_dept_dir_parent (parent_id),
      INDEX idx_dept_dir_type (structure_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_departments_directory")

  // ── Fanlar (/v1/data/subject-meta-list) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_subjects_directory (
      hemis_id        INT PRIMARY KEY,
      name            VARCHAR(255) NOT NULL,
      code            VARCHAR(100) NULL,
      is_active       TINYINT(1) NOT NULL DEFAULT 1,
      subject_group   VARCHAR(255) NULL,
      education_type  VARCHAR(120) NULL,
      synced_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_subjects_directory")

  // ── O'quv rejalar (/v1/data/curriculum-list) — har bir guruh bitta
  // curriculum'ga bog'langan (lms_groups.curriculum_id), va aynan shu
  // yerda "ta'lim shakli" (Kunduzgi/Sirtqi/Kechki/Masofaviy) rasmiy
  // ravishda ko'rsatiladi. Talabaning o'zida (hemis_students_directory)
  // ham, guruh yozuvida ham bunday maydon yo'q — faqat shu yerda bor
  // (production'da tekshirilgan: bitta HEMIS "Magistratura" bo'limi
  // ichida ham Kunduzgi, ham Masofaviy o'quv rejalar aralash turadi,
  // shuning uchun bo'lim/fakultet emas, aynan shu maydon ishonchli). ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_curricula_directory (
      hemis_id             INT PRIMARY KEY,
      name                 VARCHAR(255) NOT NULL,
      education_form_code  VARCHAR(20) NULL,
      education_form_name  VARCHAR(100) NULL,
      education_type_code  VARCHAR(20) NULL,
      education_type_name  VARCHAR(100) NULL,
      synced_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_curricula_dir_form (education_form_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_curricula_directory")
  await execIgnoreDuplicate(`ALTER TABLE lms_groups ADD COLUMN curriculum_id INT NULL AFTER course`)
  await execIgnoreDuplicate(`ALTER TABLE lms_groups ADD INDEX idx_groups_curriculum (curriculum_id)`)

  // ── Semestrlar (/v1/data/semester-list — HEMIS'da har bir o'quv reja
  // (_curriculum) o'zining semestr kalendarini olib yuradi, shu sabab
  // curriculum_id ham saqlanadi) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_semesters_directory (
      hemis_id        INT PRIMARY KEY,
      code            VARCHAR(20) NULL,
      name            VARCHAR(120) NOT NULL,
      curriculum_id   INT NULL,
      education_year  VARCHAR(20) NULL,
      level_code      VARCHAR(20) NULL,
      level_name      VARCHAR(120) NULL,
      position        INT NULL,
      is_active       TINYINT(1) NOT NULL DEFAULT 0,
      is_current      TINYINT(1) NOT NULL DEFAULT 0,
      start_date      DATE NULL,
      end_date        DATE NULL,
      synced_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sem_dir_curriculum (curriculum_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_semesters_directory")

  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_sync_status (
      id                 INT PRIMARY KEY DEFAULT 1,
      last_started_at    TIMESTAMP NULL,
      last_finished_at   TIMESTAMP NULL,
      students_count     INT NOT NULL DEFAULT 0,
      employees_count     INT NOT NULL DEFAULT 0,
      groups_count       INT NOT NULL DEFAULT 0,
      departments_count  INT NOT NULL DEFAULT 0,
      subjects_count     INT NOT NULL DEFAULT 0,
      semesters_count    INT NOT NULL DEFAULT 0,
      last_error         TEXT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_sync_status")
  await execIgnoreDuplicate(`ALTER TABLE hemis_sync_status ADD COLUMN departments_count INT NOT NULL DEFAULT 0 AFTER groups_count`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_sync_status ADD COLUMN subjects_count INT NOT NULL DEFAULT 0 AFTER departments_count`)
  await execIgnoreDuplicate(`ALTER TABLE hemis_sync_status ADD COLUMN semesters_count INT NOT NULL DEFAULT 0 AFTER subjects_count`)

  // ── HEMIS to'liq sinxronizatsiyaning HAR BIR urinishi tarixi (nafaqat
  // oxirgisi) — admin panelda "Sync History" uchun ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS hemis_sync_log (
      id                 INT AUTO_INCREMENT PRIMARY KEY,
      started_at         TIMESTAMP NOT NULL,
      finished_at        TIMESTAMP NULL,
      status             ENUM('running','success','failed') NOT NULL DEFAULT 'running',
      students_count     INT NOT NULL DEFAULT 0,
      employees_count    INT NOT NULL DEFAULT 0,
      groups_count       INT NOT NULL DEFAULT 0,
      departments_count  INT NOT NULL DEFAULT 0,
      subjects_count     INT NOT NULL DEFAULT 0,
      semesters_count    INT NOT NULL DEFAULT 0,
      error_message      TEXT NULL,
      INDEX idx_sync_log_started (started_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "hemis_sync_log")

  // Default sozlamalar
  await pool.query(`
    INSERT IGNORE INTO lms_settings (key_name, value) VALUES
      ('face_block_threshold', '3'),
      ('test_max_attempts', '1'),
      ('attendance_mode', 'auto')
  `)

  // hemis_users.teacher_user_id ni profile JSON'dagi raqamli ID dan to'ldirish
  // (OAuth orqali kirgan o'qituvchilar uchun retroaktiv backfill)
  await pool.query(`
    UPDATE hemis_users
    SET teacher_user_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(profile, '$.id')) AS UNSIGNED)
    WHERE role = 'employee'
      AND teacher_user_id IS NULL
      AND profile IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(profile, '$.id')) REGEXP '^[1-9][0-9]*$'
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(profile, '$.id')) AS UNSIGNED) > 0
  `).catch(() => { /* e'tiborsiz */ })

  // employee_id_number dan ham to'ldirish (agar id yo'q bo'lsa)
  await pool.query(`
    UPDATE hemis_users
    SET teacher_user_id = CAST(JSON_UNQUOTE(JSON_EXTRACT(profile, '$.employee_id_number')) AS UNSIGNED)
    WHERE role = 'employee'
      AND teacher_user_id IS NULL
      AND profile IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(profile, '$.employee_id_number')) REGEXP '^[1-9][0-9]*$'
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(profile, '$.employee_id_number')) AS UNSIGNED) > 0
  `).catch(() => { /* e'tiborsiz */ })
}

async function ensureColumn(table: string, column: string, definition: string) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, column]
  )
  const cnt = (rows as { cnt: number }[])[0]?.cnt ?? 0
  if (cnt === 0) {
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}


/* ── Date helpers ───────────────────────────────────────────────────── */
// mysql2 parses DATETIME/TIMESTAMP strings coming back from the server as
// local (Node process) wall-clock time, not UTC. To round-trip a UTC instant
// correctly we must therefore *write* the naive string using local-time
// components — that way the driver's local-time re-interpretation on read
// reconstructs the original UTC instant instead of shifting it by the
// server's UTC offset (e.g. +5h in Uzbekistan, silently corrupting every
// availableFrom/deadline comparison).
export function toMysqlDate(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function fromMysqlDate(value: unknown) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return new Date(value).toISOString()
  return new Date().toISOString()
}

/* ── HEMIS user cache helpers ───────────────────────────────────────── */
export interface HemisUserRow {
  hemis_id: string
  role: string
  username?: string
  full_name?: string
  hemis_token?: string
  profile?: string
  teacher_user_id?: number | null
  hemis_login?: string | null
  password_enc?: string | null
}

export async function upsertHemisUser(row: HemisUserRow) {
  await pool.query(
    `INSERT INTO hemis_users (hemis_id, role, username, full_name, hemis_token, profile, teacher_user_id, hemis_login, password_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       role            = VALUES(role),
       username        = VALUES(username),
       full_name       = VALUES(full_name),
       hemis_token     = VALUES(hemis_token),
       profile         = VALUES(profile),
       teacher_user_id = COALESCE(VALUES(teacher_user_id), teacher_user_id),
       hemis_login     = COALESCE(VALUES(hemis_login), hemis_login),
       password_enc    = COALESCE(VALUES(password_enc), password_enc),
       updated_at      = CURRENT_TIMESTAMP`,
    [
      row.hemis_id,
      row.role,
      row.username ?? null,
      row.full_name ?? null,
      row.hemis_token ?? null,
      row.profile ?? null,
      row.teacher_user_id ?? null,
      row.hemis_login ?? null,
      row.password_enc ?? null,
    ]
  )
}

export async function getHemisUser(hemisId: string): Promise<HemisUserRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM hemis_users WHERE hemis_id = ? LIMIT 1",
    [hemisId]
  )
  return rows.length ? (rows[0] as HemisUserRow) : null
}

/** Qaytgan foydalanuvchini login bo'yicha topadi — lokal parol tekshiruvi
 *  (routes/hemis.ts, tryLocalStudentLogin) shu orqali ishlaydi. Katta-kichik
 *  harf farqini e'tiborsiz qoldiradi — mavjud qatorlar dastlab qanday
 *  kiritilgan bo'lsa o'shanday saqlanib qolgan (qayta normalizatsiya
 *  qilinmagan), shu sabab qidiruv tarafida moslashamiz. */
export async function getHemisUserByLogin(login: string): Promise<HemisUserRow | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM hemis_users WHERE LOWER(hemis_login) = LOWER(?) LIMIT 1",
    [login]
  )
  return rows.length ? (rows[0] as HemisUserRow) : null
}

// HEMIS'da parol o'zgargan-yu, bizdagi kesh eskirgan holatda chaqiriladi —
// eskirgan parolni saqlab qo'ymaslik uchun tozalaymiz (keyingi refresh
// urinishlari to'g'ridan-to'g'ri "qayta kiring"ga yo'naltiriladi).
export async function clearHemisPassword(hemisId: string) {
  await pool.query("UPDATE hemis_users SET password_enc = NULL WHERE hemis_id = ?", [hemisId])
}

/* ── HEMIS API cache helpers ────────────────────────────────────────── */
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000  // 1 hour

export async function getCached(
  userId: string,
  cacheKey: string
): Promise<{ data: unknown; expired: boolean } | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT data, expires_at FROM hemis_cache WHERE user_id = ? AND cache_key = ? LIMIT 1",
    [userId, cacheKey]
  )
  if (!rows.length) return null
  const row     = rows[0]
  const expired = row.expires_at ? new Date(row.expires_at) < new Date() : false
  try {
    return { data: JSON.parse(row.data), expired }
  } catch {
    return null
  }
}

export async function setCached(
  userId: string,
  cacheKey: string,
  data: unknown,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
) {
  const expires = new Date(Date.now() + ttlMs)
  await pool.query(
    `INSERT INTO hemis_cache (user_id, cache_key, data, cached_at, expires_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
     ON DUPLICATE KEY UPDATE
       data       = VALUES(data),
       cached_at  = CURRENT_TIMESTAMP,
       expires_at = VALUES(expires_at)`,
    [userId, cacheKey, JSON.stringify(data), toMysqlDate(expires)]
  )
}

export async function clearUserCache(userId: string) {
  await pool.query("DELETE FROM hemis_cache WHERE user_id = ?", [userId])
}

/**
 * Cache-aside with HEMIS fallback:
 * 1. Fresh cache → return
 * 2. No cache / expired → call HEMIS
 *    a. HEMIS OK   → save + return fresh
 *    b. HEMIS fail → return stale cache if exists, else throw
 */
export async function withHemisCache<T>(
  userId: string,
  cacheKey: string,
  fetcher: () => Promise<T>,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
): Promise<{ data: T; source: "cache" | "hemis" }> {
  const cached = await getCached(userId, cacheKey)

  if (cached && !cached.expired) {
    return { data: cached.data as T, source: "cache" }
  }

  try {
    const data = await fetcher()
    await setCached(userId, cacheKey, data, ttlMs)
    return { data, source: "hemis" }
  } catch (err) {
    if (cached) {
      // HEMIS ishlamasa ham eski cache dan qaytaramiz
      return { data: cached.data as T, source: "cache" }
    }
    throw err
  }
}

/* ── HEMIS to'liq talaba/xodim ro'yxati (services/hemisSync.ts) ───────── */
export interface StudentDirectoryRow {
  hemis_id: number
  full_name: string
  student_id_number?: string | null
  login?: string | null
  group_id?: number | null
  group_name?: string | null
  department?: string | null
  education_form_code?: string | null
  education_form_name?: string | null
  education_type_code?: string | null
  education_type_name?: string | null
  level_code?: string | null
  level_name?: string | null
  profile?: unknown
}

export interface EmployeeDirectoryRow {
  hemis_id: number
  full_name: string
  employee_id_number?: string | null
  login?: string | null
  department?: string | null
  position?: string | null
  profile?: unknown
}

export async function upsertStudentDirectory(rows: StudentDirectoryRow[]) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO hemis_students_directory (hemis_id, full_name, student_id_number, login, group_id, group_name, department, education_form_code, education_form_name, education_type_code, education_type_name, level_code, level_name, is_active, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         full_name           = VALUES(full_name),
         student_id_number   = VALUES(student_id_number),
         login               = VALUES(login),
         group_id            = VALUES(group_id),
         group_name          = VALUES(group_name),
         department          = VALUES(department),
         education_form_code = VALUES(education_form_code),
         education_form_name = VALUES(education_form_name),
         education_type_code = VALUES(education_type_code),
         education_type_name = VALUES(education_type_name),
         level_code          = VALUES(level_code),
         level_name          = VALUES(level_name),
         is_active           = 1,
         profile             = VALUES(profile),
         synced_at           = CURRENT_TIMESTAMP`,
      [
        r.hemis_id,
        r.full_name,
        r.student_id_number ?? null,
        r.login ?? null,
        r.group_id ?? null,
        r.group_name ?? null,
        r.department ?? null,
        r.education_form_code ?? null,
        r.education_form_name ?? null,
        r.education_type_code ?? null,
        r.education_type_name ?? null,
        r.level_code ?? null,
        r.level_name ?? null,
        r.profile ? JSON.stringify(r.profile) : null,
      ]
    )
  }
}

export async function upsertEmployeeDirectory(rows: EmployeeDirectoryRow[]) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO hemis_employees_directory (hemis_id, full_name, employee_id_number, login, department, position, is_active, profile)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON DUPLICATE KEY UPDATE
         full_name          = VALUES(full_name),
         employee_id_number = VALUES(employee_id_number),
         login              = VALUES(login),
         department         = VALUES(department),
         position           = VALUES(position),
         is_active          = 1,
         profile            = VALUES(profile),
         synced_at          = CURRENT_TIMESTAMP`,
      [
        r.hemis_id,
        r.full_name,
        r.employee_id_number ?? null,
        r.login ?? null,
        r.department ?? null,
        r.position ?? null,
        r.profile ? JSON.stringify(r.profile) : null,
      ]
    )
  }
}

/**
 * HEMIS'ning FAOL ro'yxatidan endi tushib qolgan (chiqarilgan/bitirgan/
 * ishdan bo'shagan) talaba/xodimlarni DELETE qilmasdan is_active=0 qilib
 * belgilaydi — tarixiy ma'lumotlar (baholar, topshiriqlar va h.k., ular
 * hemis_id orqali bog'langan) yo'qolib qolmasligi uchun. "runStartedAt"dan
 * OLDIN yozilgan (demak shu yugurishda YANGILANMAGAN) qatorlar — aynan
 * shu tushib qolganlar, chunki upsert* funksiyalari har safar synced_at'ni
 * CURRENT_TIMESTAMP'ga yangilaydi.
 */
export async function deactivateStaleStudents(runStartedAt: Date): Promise<number> {
  const [result] = await pool.query(
    "UPDATE hemis_students_directory SET is_active = 0 WHERE is_active = 1 AND synced_at < ?",
    [toMysqlDate(runStartedAt)]
  )
  return (result as mysql.ResultSetHeader).affectedRows
}

export async function deactivateStaleEmployees(runStartedAt: Date): Promise<number> {
  const [result] = await pool.query(
    "UPDATE hemis_employees_directory SET is_active = 0 WHERE is_active = 1 AND synced_at < ?",
    [toMysqlDate(runStartedAt)]
  )
  return (result as mysql.ResultSetHeader).affectedRows
}

/* ── Fakultet/Kafedra, Fan, Semestr (services/hemisSync.ts) ──────────── */
export interface DepartmentDirectoryRow {
  hemis_id: number
  name: string
  code?: string | null
  parent_id?: number | null
  structure_type?: string | null
  is_active: boolean
  profile?: unknown
}

export interface SubjectDirectoryRow {
  hemis_id: number
  name: string
  code?: string | null
  is_active: boolean
  subject_group?: string | null
  education_type?: string | null
}

export interface CurriculumDirectoryRow {
  hemis_id: number
  name: string
  education_form_code?: string | null
  education_form_name?: string | null
  education_type_code?: string | null
  education_type_name?: string | null
}

export async function upsertCurriculumDirectory(rows: CurriculumDirectoryRow[]) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO hemis_curricula_directory (hemis_id, name, education_form_code, education_form_name, education_type_code, education_type_name)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name                = VALUES(name),
         education_form_code = VALUES(education_form_code),
         education_form_name = VALUES(education_form_name),
         education_type_code = VALUES(education_type_code),
         education_type_name = VALUES(education_type_name),
         synced_at           = CURRENT_TIMESTAMP`,
      [r.hemis_id, r.name, r.education_form_code ?? null, r.education_form_name ?? null, r.education_type_code ?? null, r.education_type_name ?? null]
    )
  }
}

export interface SemesterDirectoryRow {
  hemis_id: number
  code?: string | null
  name: string
  curriculum_id?: number | null
  education_year?: string | null
  level_code?: string | null
  level_name?: string | null
  position?: number | null
  is_active: boolean
  is_current: boolean
  start_date?: string | null
  end_date?: string | null
}

export async function upsertDepartmentDirectory(rows: DepartmentDirectoryRow[]) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO hemis_departments_directory (hemis_id, name, code, parent_id, structure_type, is_active, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name           = VALUES(name),
         code           = VALUES(code),
         parent_id      = VALUES(parent_id),
         structure_type = VALUES(structure_type),
         is_active      = VALUES(is_active),
         profile        = VALUES(profile),
         synced_at      = CURRENT_TIMESTAMP`,
      [r.hemis_id, r.name, r.code ?? null, r.parent_id ?? null, r.structure_type ?? null, r.is_active ? 1 : 0, r.profile ? JSON.stringify(r.profile) : null]
    )
  }
}

export async function upsertSubjectDirectory(rows: SubjectDirectoryRow[]) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO hemis_subjects_directory (hemis_id, name, code, is_active, subject_group, education_type)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name           = VALUES(name),
         code           = VALUES(code),
         is_active      = VALUES(is_active),
         subject_group  = VALUES(subject_group),
         education_type = VALUES(education_type),
         synced_at      = CURRENT_TIMESTAMP`,
      [r.hemis_id, r.name, r.code ?? null, r.is_active ? 1 : 0, r.subject_group ?? null, r.education_type ?? null]
    )
  }
}

export async function upsertSemesterDirectory(rows: SemesterDirectoryRow[]) {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO hemis_semesters_directory (hemis_id, code, name, curriculum_id, education_year, level_code, level_name, position, is_active, is_current, start_date, end_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         code           = VALUES(code),
         name           = VALUES(name),
         curriculum_id  = VALUES(curriculum_id),
         education_year = VALUES(education_year),
         level_code     = VALUES(level_code),
         level_name     = VALUES(level_name),
         position       = VALUES(position),
         is_active      = VALUES(is_active),
         is_current     = VALUES(is_current),
         start_date     = VALUES(start_date),
         end_date       = VALUES(end_date),
         synced_at      = CURRENT_TIMESTAMP`,
      [
        r.hemis_id, r.code ?? null, r.name, r.curriculum_id ?? null, r.education_year ?? null,
        r.level_code ?? null, r.level_name ?? null, r.position ?? null,
        r.is_active ? 1 : 0, r.is_current ? 1 : 0, r.start_date ?? null, r.end_date ?? null,
      ]
    )
  }
}

export interface HemisSyncStatus {
  last_started_at: string | null
  last_finished_at: string | null
  students_count: number
  employees_count: number
  groups_count: number
  departments_count: number
  subjects_count: number
  semesters_count: number
  last_error: string | null
}

export type HemisSyncCounts = {
  students: number
  employees: number
  groups: number
  departments: number
  subjects: number
  semesters: number
}

export async function markHemisSyncStarted(): Promise<number> {
  await pool.query(
    `INSERT INTO hemis_sync_status (id, last_started_at, last_error)
     VALUES (1, CURRENT_TIMESTAMP, NULL)
     ON DUPLICATE KEY UPDATE last_started_at = CURRENT_TIMESTAMP, last_error = NULL`
  )
  const [result] = await pool.query(
    `INSERT INTO hemis_sync_log (started_at, status) VALUES (CURRENT_TIMESTAMP, 'running')`
  )
  return (result as mysql.ResultSetHeader).insertId
}

export async function markHemisSyncFinished(logId: number, counts: HemisSyncCounts) {
  await pool.query(
    `UPDATE hemis_sync_status
     SET last_finished_at = CURRENT_TIMESTAMP, students_count = ?, employees_count = ?, groups_count = ?,
         departments_count = ?, subjects_count = ?, semesters_count = ?
     WHERE id = 1`,
    [counts.students, counts.employees, counts.groups, counts.departments, counts.subjects, counts.semesters]
  )
  await pool.query(
    `UPDATE hemis_sync_log
     SET finished_at = CURRENT_TIMESTAMP, status = 'success', students_count = ?, employees_count = ?,
         groups_count = ?, departments_count = ?, subjects_count = ?, semesters_count = ?
     WHERE id = ?`,
    [counts.students, counts.employees, counts.groups, counts.departments, counts.subjects, counts.semesters, logId]
  )
}

export async function markHemisSyncFailed(logId: number | null, message: string) {
  await pool.query(`UPDATE hemis_sync_status SET last_error = ? WHERE id = 1`, [message.slice(0, 2000)])
  if (logId !== null) {
    await pool.query(
      `UPDATE hemis_sync_log SET finished_at = CURRENT_TIMESTAMP, status = 'failed', error_message = ? WHERE id = ?`,
      [message.slice(0, 2000), logId]
    )
  }
}

export async function getHemisSyncStatus(): Promise<HemisSyncStatus | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT * FROM hemis_sync_status WHERE id = 1 LIMIT 1")
  return rows.length ? (rows[0] as unknown as HemisSyncStatus) : null
}

export async function getHemisSyncLog(limit = 20) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM hemis_sync_log ORDER BY started_at DESC LIMIT ?", [limit]
  )
  return rows
}
