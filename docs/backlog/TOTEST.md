# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

- ☐ `10006` **Customer-invoice CRUD** — create / edit / void a `Transaction` of type `customer_invoice` with line items; post balanced `LedgerEntry` rows (debit A/R, credit income) — with unit tests for invoice state transitions.
  - **Done:** `apps/api/src/invoices/service.ts` (create/get/list/update/void + `zeroOutLedger` immutable-ledger reversal), `apps/api/src/routes/invoices.ts` (POST/GET list/GET :id/PATCH/POST :id/void, JSON schemas, auth, typed-error→HTTP mapping), registered in `apps/api/src/app.ts`; unit tests in `apps/api/src/invoices/service.test.ts` (headline: create/edit/void state machine + ledger balancing/reversal/rounding) and `apps/api/src/routes/invoices.test.ts` (route/validation/auth). Verified end-to-end via `docker compose up --build`: $100 create → 1 txn + 1 line + 2 balanced ledger rows + audit row; edit → total/version updated, old ledger rows retained, net ties to new total; void → net zero, balance 0, status void; double-void and edit-of-void both 409.
