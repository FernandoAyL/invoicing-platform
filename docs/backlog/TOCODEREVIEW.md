# To code review

Tasks that passed QA and await final code review. On approval the planner moves
the task to `DONE.md` (flipping `☐ → ☑`); on rejection it goes back to `TODO.md`
with findings attached, and must pass QA again before returning here.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <developer summary>.
  - **QA:** <QA pass summary>.
```

## Phase 1 — deferred UI completions

- ☐ `10018` **Invoice-detail ledger-postings card** — org-scoped `GET /api/invoices/:id/ledger` read + debit/credit card on `routes/InvoiceDetail.tsx`. Read-only; no posting-logic change.
  - **Done:** `getInvoiceLedger(db, orgId, invoiceId)` in `apps/api/src/invoices/service.ts` (calls `getInvoice` first for org/existence/soft-delete → `NotFoundError`, then selects `ledger_entries` inner-joined `accounts`, ordered `entryDate, createdAt, id`, totals summed in integer cents via `toCents`/`formatCents`); `GET /api/invoices/:id/ledger` in `routes/invoices.ts` (401/404 mirroring `GET /:id`); `invoices-ledger.test.ts` (8, real pglite). FE: `getInvoiceLedger` + types in `apps/web/src/lib/api.ts`; "Ledger postings" `Card` on `InvoiceDetail.tsx` (main column, non-fatal load, omitted on failure/empty); `InvoiceDetail.test.tsx` (3). Commit `d9b292f`. api 476→484 (+8), web 71→74 (+3). No migration, no `ledger/posting.ts` change.
  - **QA:** PASSED. Gates: typecheck 0, 484 api + 74 web (stable serialized), biome/docker/boot-smoke/web-build (3 pages) clean. Backend mutation spot-checks: `+1` to the cents sum → exactly the 3 balanced-totals tests failed (real teeth). **Live Playwright E2E on a real docker-compose stack** (not just stubs): created a $123.45 invoice → card shows A/R debit $123.45 / Sales-Income credit $123.45 with a balanced totals row tying to the invoice total; a recorded payment does NOT alter the invoice ledger (confirms the payment posts against its own `transactionId`); forcing the ledger endpoint to 500 gracefully omits the card. **Plan-discrepancy verified correct in source** (`recordPayment` posts `transactionId: paymentRow.id`, so the invoice ledger legitimately excludes payment postings — the plan's §2-step-3 scenario was the error, not the code). Diff scope clean (no migration, no posting-logic change). **Reviewer note (QA-flagged, not a defect):** the plan's suggested "drop the ledger query's `orgId` filter" mutation does NOT fail any test because `getInvoice()` already gates org/existence first — the ledger query's `orgId` filter is defense-in-depth, not the sole gate.
