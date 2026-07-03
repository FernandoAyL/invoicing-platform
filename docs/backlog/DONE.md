# Done

Completed and verified tasks. Keep the original task ID.

## Phase 0 — Design & foundations (`0000x`)

- ☑ `00001` Architecture decisions doc (`docs/architecture-decisions.md`)
- ☑ `00002` Product requirements doc (`docs/PRD.md`)
- ☑ `00003` Project instructions (`CLAUDE.md`)
- ☑ `00004` Backlog structure (`docs/backlog/`: TODO, TOCODEREVIEW, TOTEST, DONE)
- ☑ `00008` Local dev env: `docker-compose` (postgres:17 + Node 24 app) + base tooling
  - **Delivered:** `docker-compose.yml` (Postgres 17 with healthcheck + `db-data` volume; app gated on db health, source bind-mount + anonymous `node_modules` volume for hot reload), `Dockerfile` (node:24 + Corepack/pnpm), minimal `src/index.ts` (`node:http` `/health` that pings Postgres via `pg`), `package.json` + `packageManager` pin, `tsconfig.json`, `.env.example`, `.dockerignore`, and Biome (`biome.json`, 2-space to match pnpm, `format`/`lint`/`check`/`ci` scripts). Verified: `docker compose up --build` → `GET /health` → `200 {"status":"ok","db":"up"}`; `tsc --noEmit` and `biome ci` clean.
