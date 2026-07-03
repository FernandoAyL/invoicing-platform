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

- ☐ `00009` Repo scaffolding remainder: pnpm workspace layout + typed `.env` config loader.
  - **Done:** `pnpm-workspace.yaml` (`apps/*`, `packages/*`); backend moved to `apps/api` (`@invoicing/api`) with the health server + a dependency-free typed env loader (`apps/api/src/config.ts`: required `DATABASE_URL`, validated `PORT`, `NODE_ENV`, fail-fast on missing/invalid); shared `tsconfig.base.json` extended per package (`allowImportingTsExtensions`); root `package.json` as workspace root (Biome + delegating `dev`/`typecheck` scripts). Dockerfile/compose updated for the workspace layout. Verified: `docker compose up --build` → `GET /health` → `200 {"status":"ok","db":"up"}`; `pnpm -r typecheck` and `biome ci` clean.
