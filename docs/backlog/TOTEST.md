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

- ☐ `20004` **Mapping layer: entity-typed `SyncLink` resolution (`Contact` / `Account` / `Item` / `Transaction` ↔ QBO id + type), including chart-of-accounts / GL accounts** — the DB-backed mapping service over the existing `sync_links` table plus pure natural-key matchers, that outbound (20006), inbound (20007), and idempotency (20005) build on.
  - **Done:** `apps/api/src/qbo/sync-link-service.ts` (`resolveQboType` incl. `Transaction.type`→`Invoice`/`Payment` split; `findLinkByLocal`/`findLinkByQbo`; `upsertLink` idempotent select-then-branch-in-a-tx, throws `ConflictingLinkError` on a local→different-qbo or qbo→different-local relink; `setLinkState`/`markSynced`/`markConflict`/`markFailed`; `resolveTransactionDeps` reference-data-first dependency report with `allLinked`/`unlinked`) + `apps/api/src/qbo/natural-key.ts` (pure `matchContactByNaturalKey` — email-authoritative, displayName fallback only when no email; `matchInvoiceByNaturalKey` — docNumber+total+date, or total+date+customer without a docNumber; money compared via `toCents`, never float) + `apps/api/src/qbo/errors.ts` (`UnmappableEntityError`, `ConflictingLinkError`) + tests `sync-link-service.test.ts`/`natural-key.test.ts` (createTestDb, no live QBO) + `docs/design-decisions.md` Mapping section extended. No route, no migration.
