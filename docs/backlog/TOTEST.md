# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

## Phase 0 — Design & foundations

- ☐ `00008` Local dev env: `docker-compose` running Postgres + the app on Node 24.
  - **Done:** `docker-compose.yml` (postgres:17 with healthcheck + `db-data` volume; app service gated on db health, source bind-mount + anonymous `node_modules` volume for hot reload), `Dockerfile` (node:24 + Corepack/pnpm), minimal `src/index.ts` (`node:http` `/health` endpoint that pings Postgres via `pg`), `package.json`/`tsconfig.json`, `.env.example`, `.dockerignore`. Verified: `docker compose up --build` → `GET /health` returns `200 {"status":"ok","db":"up"}`; `tsc --noEmit` clean.
