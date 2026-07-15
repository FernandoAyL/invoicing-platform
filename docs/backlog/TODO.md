# TODO

Backlog of planned work. The developer moves a task out of here to `TOTEST.md`
once implemented; on QA pass the planner moves it to `TOCODEREVIEW.md`, and on
review approval to `DONE.md`. A QA or review rejection sends the task back here
with the findings attached as a sub-bullet.

**Task IDs** are prefixed by phase: Phase 0 → `0000x`, Phase 1 → `1000x`,
Phase 2 → `2000x`, Phase 3 → `3000x`, Phase 4 (stretch) → `4000x`. Phases 0–2 are
complete, including both deferred Phase-1 UI completions (`10018`, `10019`) —
see `DONE.md`. Phase 3's GCP migration is also complete; open work there is now
correctness/security hardening surfaced by an external design review. The
original phase plan and timeline are recorded in `DONE.md#original-phase-plan`.

---

## Phase 3 — Correctness & security hardening (`3000x`)

Surfaced by external design review of the deployed GCP stack.

_No open items — see `TOTEST.md`/`DONE.md`._

---

## Phase 4 — Stretch / roadmap (`4000x`)

Beyond the 6-day target. Each item is **additive on the `10001` accounting core** —
a new `Transaction.type` and its postings, or a read-only query over `LedgerEntry` —
not a schema change. Vendor bills are the first to pull in if time allows.

- ☐ `40001` Vendor bills (AP): `vendor_bill` + `bill_payment` Transactions posting debit expense / credit A/P; two-way sync with QBO Bill / BillPayment
- ☐ `40002` Refunds & credit memos: `customer_credit_memo` and `vendor_credit` types with reversing postings; sync with QBO CreditMemo / VendorCredit
- ☐ `40003` Employee credit-card expenses: `expense` Transactions on a `credit_card` Account linked to an employee `Contact`
- ☐ `40004` Bank accounts & transfers: manage `bank` Accounts and `transfer` Transactions (reconciliation later)
- ☐ `40005` Financial reports: General Ledger, Trial Balance, Profit & Loss, Balance Sheet as read-only views over `LedgerEntry`
