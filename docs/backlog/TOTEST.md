# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

## Phase 1 — Core app + CI (`1000x`)

- ☐ `10011` **Chart of accounts** — seed the minimal accounts the customer-invoice flow needs (Accounts Receivable, Sales Income, a bank account, Undeposited Funds); a posting helper that writes balanced `LedgerEntry` rows and rejects any transaction where Σ debit ≠ Σ credit — with unit tests for ledger balancing.
  - **Done:** `apps/api/src/money.ts` (integer-cents `toCents`/`formatCents`), `apps/api/src/ledger/posting.ts` (`postLedger` + `UnbalancedError`/`InvalidPostingError`), `apps/api/src/accounts/service.ts` (`listAccounts`, `getAccountBySubtype`), `apps/api/src/routes/accounts.ts` (`GET /api/accounts`, auth, org-scoped), `apps/api/src/db/seed.ts` extended with the 4 accounts (idempotent per `orgId`+`subtype`), registered in `apps/api/src/app.ts`. Tests: `money.test.ts`, `ledger/posting.test.ts`, `routes/accounts.test.ts`.
