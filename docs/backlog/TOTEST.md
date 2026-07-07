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

- ☐ `10018` **Invoice-detail ledger-postings card** — add an org-scoped `GET /api/invoices/:id/ledger` read over the existing `LedgerEntry` rows (with a unit test), then render the debit/credit postings card on `routes/InvoiceDetail.tsx` (the comp shows it; 10016 deferred it rather than fake the rows). Read-only; no posting logic changes.
  - **Done:** `apps/api/src/invoices/service.ts` adds `getInvoiceLedger(db, orgId, invoiceId)` (calls `getInvoice` for org/existence/soft-delete → `NotFoundError` on miss, then selects `ledger_entries` inner-joined to `accounts`, ordered `entryDate, createdAt, id`, totals summed in integer cents via `toCents`/`formatCents`); `apps/api/src/routes/invoices.ts` adds `GET /api/invoices/:id/ledger` (401/404 mirroring the existing `GET /:id`); 8 new tests in `apps/api/src/routes/invoices-ledger.test.ts` (real pglite via `createTestDb`/`buildApp`/`app.inject`) covering balanced create postings, entryDate ordering across an edit, void nets to zero, cross-org 404, soft-deleted 404, unauthenticated 401, nonexistent-id 404, and confirming a same-invoice payment's own postings do **not** leak in (they post against the payment's own `transactionId`, not the invoice's — see dev note below). Frontend: `apps/web/src/lib/api.ts` adds `getInvoiceLedger`/`LedgerPosting`/`InvoiceLedger`; `apps/web/src/routes/InvoiceDetail.tsx` loads the ledger alongside the invoice/payments (non-fatal on failure) and renders a "Ledger postings" `Card` (main column, after Payments) with per-account debit/credit rows + a bold balanced totals row, omitted when the read fails or there are no entries; `apps/web/src/routes/InvoiceDetail.test.tsx` (3 new tests) covers the rendered rows/totals and both omission cases. api 476→484 (+8), web 71→74 (+3). No migration, no posting-logic change.
