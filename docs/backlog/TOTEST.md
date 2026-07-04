# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

## Phase 1 — Core app + CI

- ☐ `10004` Auth: email/password session login, httpOnly cookie, logout, seeded users, Admin/Member roles
  - **Done:** DB-backed opaque-token sessions (`apps/api/src/db/schema.ts` `sessions` table,
    migration `apps/api/drizzle/0001_huge_newton_destine.sql`); `apps/api/src/auth/password.ts`
    (scrypt hash/verify, never throws), `apps/api/src/auth/session.ts` (token mint/hash,
    create/find/delete session); `apps/api/src/plugins/auth.ts` (`@fastify/cookie`, `authenticate`
    + `requireRole` preHandlers); `apps/api/src/routes/auth.ts` (`POST /api/auth/login` with
    timing-safe unknown-email handling, `POST /api/auth/logout` idempotent, `GET /api/auth/me`);
    `apps/api/src/db/seed.ts` (idempotent org + admin/member users, `db:seed` script);
    `apps/api/src/config.ts` + `.env.example` (`SESSION_SECRET`, `SESSION_TTL_HOURS`,
    `SEED_ADMIN_PASSWORD`/`SEED_MEMBER_PASSWORD`); `plugins/db.ts`/`app.ts` extended to accept an
    injectable `db` (mirrors the existing injectable-pool pattern) for route-level unit tests.
    Unit tests: `auth/password.test.ts`, `auth/session.test.ts`, `routes/auth.test.ts` (login
    200/401/400, me 200/401, logout 204 + idempotent, `requireRole` 403/200) — 28/28 passing.
    Verified end-to-end against real Postgres (`docker compose`): migrate + seed (idempotent,
    2 users), login sets httpOnly/SameSite=Lax cookie, `/me` 200→logout 204→`/me` 401, `sessions`
    row removed on logout. `pnpm -r typecheck`, `pnpm -r test`, `biome ci`, `docker build` all
    clean.
