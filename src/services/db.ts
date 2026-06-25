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
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
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
      synced_to_main_backend  BOOLEAN NOT NULL DEFAULT FALSE,
      created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_attendance_user (meeting_id, user_id),
      CONSTRAINT fk_att_meeting FOREIGN KEY (meeting_id) REFERENCES lms_meetings(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `)

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
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN attempts_count INT NULL AFTER max_score`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN question_display_count INT NULL AFTER attempts_count`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN language VARCHAR(20) NULL AFTER question_display_count`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN topic_key VARCHAR(255) NULL AFTER subject_name`)
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD INDEX idx_teacher_content_topic_key (topic_key)`)

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

  // ── lms_teacher_content: resurs uchun ball + test sozlamalari ──
  await execIgnoreDuplicate(`ALTER TABLE lms_teacher_content ADD COLUMN completion_points INT NULL DEFAULT NULL`)

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
  await ensureColumn("lms_exam_sessions", "option_perms", "TEXT NULL DEFAULT NULL")

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

  // ── Admin ruxsatnomalar: kimga qanday LMS roli berilgan ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_permissions (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      hemis_id    VARCHAR(255) NOT NULL,
      full_name   VARCHAR(255),
      hemis_role  VARCHAR(100),
      lms_role    ENUM('admin','teacher','student','blocked','pending') NOT NULL DEFAULT 'pending',
      granted_by  VARCHAR(255),
      granted_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      note        VARCHAR(500),
      UNIQUE KEY uq_perm_hemis_id (hemis_id),
      INDEX idx_perm_lms_role (lms_role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_permissions")

  // ── Tizim sozlamalari (admin tomonidan o'zgartiriladigan) ──
  await execSafe(`
    CREATE TABLE IF NOT EXISTS lms_settings (
      key_name   VARCHAR(100) PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `, "lms_settings")

  // Default sozlamalar
  await pool.query(`
    INSERT IGNORE INTO lms_settings (key_name, value) VALUES
      ('face_block_threshold', '3'),
      ('test_max_attempts', '1')
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
}

export async function upsertHemisUser(row: HemisUserRow) {
  await pool.query(
    `INSERT INTO hemis_users (hemis_id, role, username, full_name, hemis_token, profile, teacher_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       role            = VALUES(role),
       username        = VALUES(username),
       full_name       = VALUES(full_name),
       hemis_token     = VALUES(hemis_token),
       profile         = VALUES(profile),
       teacher_user_id = COALESCE(VALUES(teacher_user_id), teacher_user_id),
       updated_at      = CURRENT_TIMESTAMP`,
    [
      row.hemis_id,
      row.role,
      row.username ?? null,
      row.full_name ?? null,
      row.hemis_token ?? null,
      row.profile ?? null,
      row.teacher_user_id ?? null,
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
