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

Copy `.env.example` if present, or create `.env` manually before running.
