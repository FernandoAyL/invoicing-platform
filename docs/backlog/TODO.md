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

- ☐ `30023` **Fix the `listInvoices` N+1 query** — `listInvoices` (`apps/api/src/invoices/service.ts:560-593`) fetches the transaction rows, then issues one extra `transactionLines` query per invoice inside `Promise.all`. Replace with a single batched query (`inArray(transactionLines.transactionId, ids)`) and group lines by invoice id in memory. Add/extend a test asserting the line-fetch is O(1) queries regardless of invoice count.
- ☐ `30025` **Reduce duplicated boilerplate via static analysis** — run a duplicate-code pass over `apps/api/src` (e.g. `jscpd`, or a Biome duplicate-detection rule) to find copy-pasted org-scoped load/mutate blocks across the `*/service.ts` modules and the repeated `if (err instanceof ...)` error-mapping chains in `routes/*.ts`, then extract shared helpers (a generic "load-scoped-row-or-404", a route error-mapper) where it doesn't hurt readability. Wire the check into `pnpm ci` if a low-noise threshold can be found; otherwise run it as a one-off cleanup pass.
- ☐ `30026` **Harden QBO natural-key query-string construction against malformed input** — an external take-home checker flagged `upsertLink` for a "SQL injection risk due to lack of parameterization"; that specific claim doesn't hold (`sync-link-service.ts`'s inserts/updates all go through Drizzle's parameterized query builder — no raw SQL, nothing to inject). The real analogous risk lives in `apps/api/src/qbo/retry-sweep.ts`'s `reconcileDocumentCreate`/`reconcileContactCreate` (`retry-sweep.ts:69-71,102-104,176-178`): the QBO query-API `where` clause is built by string-interpolating `txn.docNumber`/`contact.email` through a hand-rolled `escapeQboString` (backslash + single-quote escaping only) — QBO's query API has no parameterized-query mechanism, so this interpolate-and-escape approach is the only option, but its coverage is incomplete: the `TxnDate` fallback branch (`retry-sweep.ts:104`) interpolates `txn.txnDate` **without** calling `escapeQboString` at all. If `escapeQboString`'s two-character escaping misses something in QBO's actual query grammar (or `txnDate` ever contains anything unexpected), a crafted value could alter the `where` clause and mismatch/link the wrong QBO record during create-retry reconciliation. Fix: escape the `TxnDate` branch too, audit `escapeQboString` against QBO's documented query-language escaping rules (not just backslash/quote), and add a test with adversarial `docNumber`/email/date values (embedded quotes, backslashes) proving the constructed `where` never breaks out of the intended field comparison.

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
