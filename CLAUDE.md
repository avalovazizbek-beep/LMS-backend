# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start with ts-node-dev (hot reload)
npm run build    # Compile TypeScript → dist/
npm start        # Run compiled dist/server.js
```

There are no tests. No linting script is configured.

## Architecture

Express.js + TypeScript REST API for a university LMS. The stack is intentionally simple — **no database**: all state lives in in-memory arrays and maps declared in `src/db/data.ts`. Data resets on every server restart.

### Entry point

`src/server.ts` mounts all 12 route modules under `/api/<module>` and applies the CORS config (origin from `FRONTEND_URL` env var).

### Auth flow

- `POST /api/auth/login` issues a JWT (7-day expiry, signed with `JWT_SECRET`).
- `src/middleware/auth.ts` exports two guards:
  - `authMiddleware` — validates JWT, attaches user to `req.user`
  - `requireRole(...roles)` — restricts a route to specific roles

**Roles** (hierarchy matters for access): `super_admin` → `admin` → `moderator` → `seller` → `master` → `student`

### Data layer (`src/db/data.ts`)

All TypeScript interfaces and mutable arrays live here. Adding a new entity means: define the interface, add the array, export it, and import it in the relevant route file. No migrations needed.

Notable storage:
- `faceStore: Map<string, FaceEntry>` — face descriptors with 30-day TTL (checked at verify time)
- `reqStore: ReRegisterRequest[]` — pending face re-registration requests

### Route modules (`src/routes/`)

| File | Domain |
|------|--------|
| `auth.ts` | Login, `/me` |
| `users.ts` | CRUD for admins / moderators / sellers / masters |
| `groups.ts` | Class groups |
| `exams.ts` | Exam scheduling |
| `finance.ts` | Payment tracking (`PATCH /:id/pay`) |
| `documents.ts` | Document library (`PATCH /:id/download` increments counter) |
| `meetings.ts` | Virtual meetings (`PATCH /:id/done`) |
| `notifications.ts` | Per-user alerts + broadcast (`PATCH /read-all`) |
| `board.ts` | Pinnable announcements (`PATCH /:id/pin`) |
| `schedule.ts` | Schedules, attendance, grades (auto-computes GPA + A–F letter from midterm/final/independent scores) |
| `hemis.ts` | Proxy to external HEMIS university API (student & employee login, file download) |
| `face.ts` | Facial recognition for exam proctoring (register / verify / re-register) |

### HEMIS integration (`src/routes/hemis.ts`)

HEMIS is an external university system. The route acts as a proxy — it forwards credentials to the HEMIS API and returns the token/data to the client. The `HEMIS_*` env vars (base URL, credentials) must be set for this to work. Error extraction is centralised in a helper inside the file.

Login methods, both available to students and employees:
- **Direct password** (`POST /login`, `/employee-login`, `/auto-login`): the LMS's own form posts login+password straight to HEMIS's REST/Tutor API. `/auto-login` tries the student API first, then the employee Tutor API.
- **OAuth** (`GET /oauth/start/:role` → HEMIS login page → `GET /oauth/:role` callback): role is `student`, `employee`, `tutor`, or `auto` (tries to detect student vs employee from the HEMIS OAuth user payload — this is what the frontend's single "HEMIS orqali kirish" button uses).

**Credential cache + silent refresh**: on every successful *password*-based login, the plaintext password is encrypted (AES-256-GCM, `src/services/credentialCrypto.ts`, key from `HEMIS_CREDENTIALS_KEY`) and stored in `hemis_users.password_enc` alongside `hemis_login`, keyed by `hemis_id`. `POST /refresh` (mounted before `authMiddleware` so it accepts an *expired* JWT — signature is still verified) decrypts the stored password and re-authenticates against HEMIS to mint a fresh JWT without asking the user to type their credentials again. If HEMIS rejects the cached password (changed on their end), the cache is cleared and the client must fall back to a normal login. OAuth-based logins never populate this cache (no password is ever seen by the LMS in that flow) — only password-based logins do, and only they benefit from `/refresh` (OAuth sessions simply require a new browser round-trip once their JWT expires).

**Rate limits (measured live, 2026-09-15)**: HEMIS's password endpoints (`/v1/auth/login`, `/ver1/tutor/auth/login`) enforce a hard per-IP anti-abuse block (`429`/`CAPTCHA_REQUIRED`). OAuth's two server-to-server calls (`hemisOAuthAccessToken`, `hemisOAuthUser`) go through the same `acquireHemisLoginSlot` queue as password logins so a burst of simultaneous OAuth logins can't hit HEMIS any harder — but OAuth is **not** the primary login option in the UI (tried and explicitly reverted by the user twice, see the login page's own file for why — don't redo this without asking). Separately, the admin-token `/v1/data/*` family (`HEMIS_TOKEN`) has its own, gentler rate limit — observed `X-Rate-Limit-Limit: 10` per window. `src/services/hemisSync.ts` respects this with a strict sequential+throttled pagination loop (~6.5s between requests, up to 4 attempts with backoff per page on error); do not add concurrency back to that file without re-measuring the limit.

### HEMIS full directory sync (`src/services/hemisSync.ts`)

Independent of login entirely — pulls the full **active** student, employee, group, department/faculty, subject, and semester lists university-wide via the admin `HEMIS_TOKEN` (`/v1/data/student-list`, `/employee-list`, `/group-list`, `/department-list`, `/subject-meta-list`, `/semester-list`), storing them in `hemis_students_directory` / `hemis_employees_directory` / `lms_groups` / `hemis_departments_directory` / `hemis_subjects_directory` / `hemis_semesters_directory`. Runs once on server startup and then on a `HEMIS_SYNC_INTERVAL_MS` interval (`server.ts`); can also be triggered on demand via `POST /api/admin/hemis-directory-sync` (last-run status at `GET /api/admin/hemis-directory-sync/status`, per-run history at `GET /api/admin/hemis-directory-sync/log`). Purpose: let roster/lookup features read from local MySQL instead of calling HEMIS live on every request — it does **not** and cannot replace password verification (HEMIS never exposes passwords via any API).

- `hemis_departments_directory` covers both faculties and departments/chairs — HEMIS models them as one resource (`Department`), distinguished by `structure_type` (e.g. "Fakultet" vs "Kafedra" vs "Bo'lim").
- `hemis_semesters_directory` is per-curriculum (`curriculum_id`), not a small global list — HEMIS's semester calendar is defined per study plan, so there are thousands of rows, not ~8.
- Students/employees no longer in HEMIS's active list are **not deleted** — `deactivateStaleStudents`/`deactivateStaleEmployees` mark them `is_active = 0` (matched via `synced_at` older than the current run's start) so historical data (grades, submissions, etc.) keyed by `hemis_id` stays intact.
- `runFullHemisSync` syncs each of the six resources independently (`syncOneResource`) — one resource failing (e.g. a transient timeout) doesn't stop the others; the run is marked `failed` only if the status/log should reflect a partial error, but every resource that did succeed is already committed to its own table regardless.

### Language note

Error messages, API responses, and some identifiers are written in **Uzbek**. This is intentional — the target users are Uzbek-speaking. Keep new messages consistent with existing language conventions.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 5000) |
| `JWT_SECRET` | JWT signing secret |
| `JWT_EXPIRES_IN` | Token lifetime (default `7d`) |
| `FRONTEND_URL` | Allowed CORS origin (default `http://localhost:3000`) |
| `HEMIS_CREDENTIALS_KEY` | Key for AES-256-GCM encryption of cached HEMIS passwords (`hemis_users.password_enc`). Falls back to `JWT_SECRET` if unset — set a dedicated value in production. |
| `HEMIS_SYNC_INTERVAL_MS` | How often the full HEMIS directory sync (`src/services/hemisSync.ts`) re-runs in the background (default 6h = `21600000`). |

Copy `.env.example` if present, or create `.env` manually before running.
