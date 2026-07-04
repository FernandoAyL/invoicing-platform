# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

- ☐ `10007` **Payments: record a payment `Transaction` against an invoice; post ledger (debit bank / undeposited funds, credit A/R); derive paid / partial / unpaid status — with unit tests for status derivation**
  - **Done:** `payment_applications` join table + migration `apps/api/drizzle/0004_nebulous_stature.sql` (schema: `apps/api/src/db/schema.ts`); `zeroOutLedger` extracted from `apps/api/src/invoices/service.ts` into shared `apps/api/src/ledger/posting.ts` (invoices re-point at it, no behavior change); pure `deriveInvoiceStatus` in `apps/api/src/payments/status.ts` (+ exhaustive `status.test.ts`); `apps/api/src/payments/service.ts` (`recordPayment`/`listPaymentsForInvoice`/`getPayment`/`voidPayment`, atomic, org-scoped, typed errors → 400/404/409/422, audited) + `service.test.ts`; `apps/api/src/routes/payments.ts` (`POST /api/invoices/:id/payments`, `GET /api/invoices/:id/payments`, `GET /api/payments/:id`, `POST /api/payments/:id/void`) + `payments.test.ts`; registered in `apps/api/src/app.ts`. Verified end-to-end via `docker compose up --build`: partial (40) → `partially_paid`/60.00, full (60) → `paid`/0.00, overpayment (120 on fresh $100 invoice) → 422 nothing written, pay-a-paid-invoice → 409, void → invoice back to `partially_paid`/60.00 with ledger net-zero (rows retained) + application removed + audit `void` row, double-void → 409; invoice edit/void guards on `partially_paid` still 409 (regression).
