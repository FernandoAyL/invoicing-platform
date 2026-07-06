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

_(empty)_

## Phase 2 — Sync engine + CD

- ☐ `20015` **Real-Postgres (pglite) integration-test harness** — the hand-rolled fake-DB harness (`insert().values()` pushes JS objects into arrays) does not enforce Postgres column types/constraints/transactions, which masked **both** `20002` defects (a boot-crash needing a live boot, and a `uuid`-column type mismatch needing real Postgres — caught only by manual QA). Every remaining sync task (`20004`–`20011`) writes typed rows (`SyncLink`/`Transaction`/`ledger`/audit). Add an in-memory real-Postgres harness via `@electric-sql/pglite` + `drizzle-orm/pglite`, applying the **same migrations** shipped to prod (schema parity), exposed as a `createTestDb()` helper usable from Vitest so CI catches type/constraint bugs automatically. Port at least the webhook + one existing service test to it to prove parity, and add a CI **app-boot smoke** (run the built image under `node src/index.ts` so a boot-crashing TS construct fails the pipeline). This was flagged as due "when Phase 2 lands" in the `10010` review. Sequenced next, before `20004`.
  - **Done:** Added `createTestDb()`/`seedBaseOrg()` harness (`apps/api/src/__tests__/helpers/test-db.ts`, `@electric-sql/pglite` + `drizzle-orm/pglite`, applying the real `apps/api/drizzle/*.sql` migrations to a fresh in-memory PGlite instance), cast to `NodePgDatabase<typeof schema>` so no service/`buildApp` signatures changed. Added `test-db.test.ts` proving the harness rejects a non-uuid value in a `uuid` column (the `20002`-class bug the fake db silently accepted). Ported `apps/api/src/audit/service.test.ts` fully, and the DB-touching cases of `apps/api/src/routes/qbo-webhook.test.ts` (success path, unknown realm, multi-notification/multi-org, and the login regression) to `createTestDb()`; the remaining pure signature/parse/config cases in that file stay on the fake db (no DB write on those paths). Added a CI app-boot smoke step to the `verify` job in `.github/workflows/ci.yml` (dynamic `import('./src/app.ts')` under real `node`, dummy `DATABASE_URL`/`SESSION_SECRET`), verified locally to print `boot import ok`/exit 0 and to fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` when a parameter-property is reintroduced. Documented the two-tier test story in `docs/architecture-decisions.md`. `apps/api/package.json` + `pnpm-lock.yaml` gained the `@electric-sql/pglite` devDependency; confirmed `docker build` installs it cleanly and the boot smoke also passes inside the built image.
