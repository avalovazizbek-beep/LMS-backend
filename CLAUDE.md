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

### Language note

Error messages, API responses, and some identifiers are written in **Uzbek**. This is intentional — the target users are Uzbek-speaking. Keep new messages consistent with existing language conventions.

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 5000) |
| `JWT_SECRET` | JWT signing secret |
| `JWT_EXPIRES_IN` | Token lifetime (default `7d`) |
| `FRONTEND_URL` | Allowed CORS origin (default `http://localhost:3000`) |

Copy `.env.example` if present, or create `.env` manually before running.
