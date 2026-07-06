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

- ☐ `10016` **Invoice detail + record-payment restyle** — invoice document card, Payments list, Record-payment form (API-backed fields only), sync-status card. Ledger-postings card **deferred** (user directive).
  - **Done:** Restyled `routes/InvoiceDetail.tsx` — back link + header (mono "Invoice INV-xxxx" + `InvoiceStatusBadge` + date/due) with gated actions (Record payment primary / Edit secondary / Void danger — Edit+Void only when `status==='open'`, Record payment when `open|partially_paid`, exactly as before); a two-column layout: left = the **document `Card`** (BILL TO customer + email, a grid line-items table Description/Qty/Unit price/Amount, then Subtotal/Total/**Paid** (= total − balance)/**Balance** totals block) + a **Payments** `Card` (mono amount + date + a small void/paid status pill + `Void` ghost action per row, or "No payments recorded yet."), right = a **Sync status** `Card` (Phase-1 `SyncStatusBadge` + an honest "Not yet synced to QuickBooks — sync starts in a later phase" note → Integrations; **no resolve/retry**). load/not-found/error via `LoadingState`/`EmptyState`/`ErrorState`; void-invoice/void-payment + `actionError` (`role=alert`) behaviour preserved verbatim. Restyled `components/RecordPaymentDialog.tsx` into a proper **modal** (fixed `rgba(20,35,28,.28)` overlay + centered `Card` + `Input`/`Select`/`Button`); **only the API-backed fields** (amount `mono` prefilled to balance, date, deposit-account picker defaulting to Undeposited Funds, memo) + the **overpayment-422 inline** handling; `role="dialog"`/`aria-modal`/`aria-label`, the labeled fields, the deposit `<option>`s, "Record payment"/"Cancel", and `role=alert` all preserved (backdrop-click-to-close dropped — it tripped a11y lint and the Cancel button already closes). **Ledger-postings card deferred** per user directive (no `GET /api/invoices/:id/ledger` endpoint added — no API change anywhere; the comp's debit/credit rows are intentionally omitted rather than faked). No "Save & sync" strings. **Verified:** web `vitest` 50/50 (RecordPaymentDialog contract intact — amount prefill/`toHaveValue(60)`, `{type:'asset'}` accounts + option name, record → `onRecorded`, 422 alert + dialog stays), `tsc` + `biome ci` clean, SSG unchanged (auth-gated — still 3 public pages). **Live Playwright visual QA** (route-stubbed): partially_paid detail (Paid $450 / Balance $1,000, payment row + Void, sync card) + the record-payment modal (amount prefilled $1,000) + open-invoice variant (Edit + Void shown, empty payments) all render correctly in the shell.
