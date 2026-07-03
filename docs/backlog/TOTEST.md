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

- ☐ `10001` Drizzle schema + first migration — accounting core.
  - **Done:** `apps/api/src/db/schema.ts` — 11 tables (organizations, users, contacts, accounts, items, transactions, transaction_lines, ledger_entries, qbo_connections, sync_links, sync_audit_logs) + 8 pg enums (account/transaction type + status, sync entity/state/direction/outcome, user role). Money as `numeric(14,2)`, uuid PKs, org-scoped FKs, self-ref `accounts.parent_id`, cascade delete on lines/ledger, entity-typed `sync_links` with unique local/qbo keys. `drizzle.config.ts` + generated `drizzle/0000_young_siren.sql`; scripts `db:generate` (drizzle-kit) and `db:migrate` (programmatic `src/db/migrate.ts` via drizzle-orm migrator). Biome excludes generated `drizzle/`. **Verified:** `db:migrate` over the docker network → 11 tables created + tracked in `drizzle.__drizzle_migrations`; `tsc --noEmit` and `biome ci` clean.
