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

- ☐ `10003` Fastify server bootstrap.
  - **Done:** replaced the `node:http` placeholder with Fastify. `src/app.ts` (`buildApp`, injectable pool for tests), `src/plugins/db.ts` (fastify-plugin decorating `pool` (pg) + `db` (drizzle), owns pool lifecycle via `onClose`), `src/routes/health.ts` (`GET /health` pings the pool), `src/index.ts` (listen on `0.0.0.0:config.port`, graceful SIGTERM/SIGINT). Pino structured logging (pretty in dev via pino-pretty, JSON otherwise). Unit tests `src/routes/health.test.ts` (200 up / 503 down via `app.inject` + fake pool). **Verified:** `docker compose up --build` → `GET /health` `200 {"status":"ok","db":"up"}` with structured request logs; `vitest` 6/6, `pnpm -r typecheck` + `biome ci` clean.
