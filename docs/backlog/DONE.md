# Done

Completed and verified tasks. Keep the original task ID.

## Phase 0 — Design & foundations (`0000x`)

- ☑ `00001` Architecture decisions doc (`docs/architecture-decisions.md`)
- ☑ `00002` Product requirements doc (`docs/PRD.md`)
- ☑ `00003` Project instructions (`CLAUDE.md`)
- ☑ `00004` Backlog structure (`docs/backlog/`: TODO, TOCODEREVIEW, TOTEST, DONE)
- ☑ `00005` Register QuickBooks Online developer account + sandbox company
- ☑ `00006` Create QBO app: OAuth client id/secret, redirect URIs, webhook endpoint
- ☑ `00007` AWS account + IAM for Terraform; S3 remote state backend with native locking (`use_lockfile`)
- ☑ `00008` Local dev env: `docker-compose` (postgres:17 + Node 24 app) + base tooling
  - **Delivered:** `docker-compose.yml` (Postgres 17 with healthcheck + `db-data` volume; app gated on db health, source bind-mount + anonymous `node_modules` volume for hot reload), `Dockerfile` (node:24 + Corepack/pnpm), minimal `src/index.ts` (`node:http` `/health` that pings Postgres via `pg`), `package.json` + `packageManager` pin, `tsconfig.json`, `.env.example`, `.dockerignore`, and Biome (`biome.json`, 2-space to match pnpm, `format`/`lint`/`check`/`ci` scripts). Verified: `docker compose up --build` → `GET /health` → `200 {"status":"ok","db":"up"}`; `tsc --noEmit` and `biome ci` clean.
- ☑ `00009` Repo scaffolding remainder: pnpm workspace layout + typed `.env` config loader
  - **Delivered:** `pnpm-workspace.yaml` (`apps/*`, `packages/*`); backend at `apps/api` (`@invoicing/api`) with a dependency-free typed env loader (`apps/api/src/config.ts`); shared `tsconfig.base.json` extended per package; root `package.json` as workspace root. Verified: `docker compose up --build` → `/health` `200`; `pnpm -r typecheck` + `biome ci` clean.

## Phase 1 — Core app + CI (`1000x`)

- ☑ `10001` Drizzle schema + first migration — accounting core
  - **Delivered:** `apps/api/src/db/schema.ts` — 11 tables + 8 pg enums (unified `transactions` + `transaction_lines` + `ledger_entries`, `contacts` role flags, chart-of-accounts `accounts`, entity-typed `sync_links`). Money `numeric(14,2)`, uuid PKs, org-scoped FKs, self-ref `accounts.parent_id`, cascade on lines/ledger. `drizzle.config.ts` + `drizzle/0000_young_siren.sql`; `db:generate` + programmatic `db:migrate` (`src/db/migrate.ts`). Verified: migration applies over docker network (11 tables + `drizzle.__drizzle_migrations`); `tsc --noEmit` + `biome ci` clean.
- ☑ `10002` CI (GitHub Actions) + Vitest setup
  - **Delivered:** `.github/workflows/ci.yml` (push to `main` + PRs): install → `biome ci` → `pnpm -r typecheck` → `pnpm -r test` → `docker build`. Vitest wired (`apps/api` + root `test` scripts, `vitest.config.ts`); `config.ts` refactored to testable `loadConfig(env)` + `config.test.ts` (4 cases). Verified: `vitest` 4/4, `biome ci`/typecheck clean, **CI green on GitHub**.
- ☑ `10003` Fastify server bootstrap
  - **Delivered:** replaced the `node:http` placeholder with Fastify. `src/app.ts` (`buildApp`, injectable pool for tests), `src/plugins/db.ts` (fastify-plugin decorating `pool` (pg) + `db` (drizzle), owns pool lifecycle via `onClose`), `src/routes/health.ts` (`GET /health` pings the pool), `src/index.ts` (listen on `0.0.0.0:config.port`, graceful SIGTERM/SIGINT). Pino structured logging (pretty in dev via pino-pretty, JSON otherwise). Unit tests `src/routes/health.test.ts` (200 up / 503 down via `app.inject` + fake pool). **Verified:** `docker compose up --build` → `GET /health` `200`; `vitest` 6/6, typecheck + `biome ci` clean; **CI green, merged to `main` via PR #8**.
