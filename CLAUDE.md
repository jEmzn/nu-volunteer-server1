# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

NestJS 11 + PostgreSQL 16 backend for NU Volunteer, Naresuan University's volunteer-hours web app. It replaces the old site's direct browser-to-Supabase access. The client is `../nu-volunteer-web`.

## Commands

Requires Node 22+. PostgreSQL and Docker are not needed for development: `embedded-postgres` runs a real server.

```bash
npm run db:dev                 # local PostgreSQL on port 54330, data in .dev-db/, prints DATABASE_URL
node scripts/dev-db.js --fresh # wipe the local database and start over
npm run build                  # compile src/ to dist/
npm start                      # run dist/main.js, needs .env (copy from .env.example)
npm run dev                    # tsc --watch only, does not run the server
npm run typecheck              # also checks test/

npm test                                             # all tests
npx jest --runInBand test/claims.test.ts             # one file
npx jest --runInBand test/claims.test.ts -t "location"  # by test name
k6 run -e BASE_URL=http://localhost:3000 -e ORG_CODE=DEV-ORG load/claims.k6.js  # load test
```

There is no linter configured. The local database seeds the organisation codes `DEV-ORG`, `DEV-ORG-2` and `DEV-ADMIN` (admin). `JWT_SECRET` and `QR_SECRET` must each be at least 32 bytes and different from each other, or the server refuses to start.

API docs are served at `/api/docs` while the server runs.

## Tests

- Nothing is mocked. `test/global-setup.js` starts one PostgreSQL on port 54329 and loads `db/schema.sql`, and tests run the real app through `startApp()` in `test/helpers.ts`.
- Always use `--runInBand`: files share one database and `resetDb()` truncates every table.
- `test/env.js` sets very high rate limits so tests never hit them. `test/rate-limit.test.ts` lowers them itself.

## Architecture

**Module layout.** Each `src/modules/<name>/<name>.ts` holds its DTOs, service, controller and Nest module in one file. Shared code is in `src/common/`. `src/app.setup.ts` holds middleware, pipes, filters and CORS, and is used by both `main.ts` and the tests, so tests run the real stack.

**Auth is closed by default.** `AuthGuard` is global: a route needs a valid token unless it is marked `@Public()`, and `@Roles(...)` narrows it further. On public routes an invalid token is ignored rather than refused. Identity always comes from the JWT, never from the request body (`CurrentUser`). Ownership is checked in services:
- `assertOwner`: the activity's organisation, or an admin.
- `assertCanEdit`: `assertOwner` plus the lock rule. Owners can edit until the roster is submitted, admins until it is recorded; after that the response is 409 `ROSTER_LOCKED`.

**Concurrency runs through the activity row.** Writes that can collide run inside `db.tx()` and call `lockActivity()` (`SELECT ... FOR UPDATE`) first, so requests on one activity run one at a time. `reg_count` and `credit_count` on `activities` are maintained by this code in those transactions. There is no ORM, only raw SQL through `pg`. `ACTIVITY_RULE_COLUMNS` deliberately leaves out `poster` and `description`, because a poster can be 300 KB and this row is read on every scan. For the same reason reads never send an uploaded image: `ACTIVITY_COLUMNS` turns it into a URL on `GET /activities/:id/poster`, and the web adds the API address in `remote.ts`.

**All credits go through `writeCredit()`** in `modules/claims/credit-writer.ts`, for QR scans, manual additions and bottles alike. It handles the duplicate check, the `device` flag, walk-in registration, counters and the notice. It must run in a transaction that already holds the activity lock.

**Lost credits are counted on the server only.** `listStrikes()` in `modules/roster/strikes.ts` holds the rule: registering checks it, and `GET /students/:id/strikes` sends it to the web, which shows it without counting. The centre admin gives credits back with `PATCH /activities/:id/registrations/:studentId`.

**The server decides check-ins.** `POST /activities/:id/qr` signs a token, and `POST /claims` verifies it and judges location from raw coordinates. Location never blocks a claim; it only adds a flag for supervisors to review. Pure rules are in `modules/claims/rules.ts` and `modules/qr/qr-token.ts`.

**Realtime is a signal only.** Socket.IO sends `changed` with a room name and clients reload over REST. Call `realtime.notify()` after the transaction commits, never inside it. The `rooms.after*` helpers list which rooms a write affects. Permission to join a room is decided in `RealtimeGateway.decide()`.

**API shape.**
- `src/common/fields.ts` decorators (`Str`, `Int`, `OneOf`, ...) combine validation and OpenAPI metadata. Use them on DTOs rather than raw class-validator decorators.
- In a PATCH, a missing key means no change and `null` means clear the field. Use `assertNotNull` for fields that cannot be cleared.
- `src/common/mappers.ts` converts rows (snake_case, `Date`) to JSON (camelCase, ms), and leaves out keys with no value. It also applies per-viewer rules: `orgCode` goes only to that organisation's supervisors and admins, because it is the only supervisor credential.
- Throw `ApiError` with a stable `code`, which the web reads. `AllExceptionsFilter` shapes every error.

**Startup order matters.** `main.ts` loads `.env` before dynamically importing `AppModule`, because modules read `process.env` while they are being defined.

**Database.** `db/schema.sql` holds tables and indexes only, and there are no migrations. Business rules live in the API, not in Postgres functions, RLS or triggers. A real database must be created with UTF8 encoding or Thai text cannot be stored.

## Documents to keep in step

- `docs/API-CONTRACT.md` is the authoritative API contract for the web client and wins over `/api/docs`. Update it when an endpoint changes.
- `docs/WORKLOG.md` records work, decisions and test results, in Thai.
- `ข้อกำหนด Backend Server.md` is the requirements spec; code comments such as "spec 8.2" refer to it. Agreed deviations and known risks are listed in `README.md`.
- `DATABASE.md` lists the table columns.

## Constraints

- Run one API instance only. Rate limits and Socket.IO state are in memory, so scaling out needs a Redis adapter first.
- NestJS stays on 11: version 12 is ESM-only and does not work easily with Jest.
- Behind a proxy, set `TRUST_PROXY=1`, or all users count as one IP in the rate limits.
- Docker, Compose, Nginx and daily backups do not exist yet (see `README.md`).
- To test against the web client, run `npm run e2e` in `../nu-volunteer-web`. It starts this backend itself.
