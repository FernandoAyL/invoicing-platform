# TODO

Backlog of planned work, grouped into phases. The developer moves a task out of
here to `TOTEST.md` once implemented; on QA pass the planner moves it to
`TOCODEREVIEW.md`, and on review approval to `DONE.md`. A QA or review rejection
sends the task back here with the findings attached as a sub-bullet.

**Task IDs** are prefixed by phase: Phase 0 → `0000x`, Phase 1 → `1000x`,
Phase 2 → `2000x`, Phase 3 → `3000x`, Phase 4 (stretch) → `4000x`.

**Timeline** — target deploy end of day **Wed Jul 8** (~6 days from Thu Jul 2).

| Phase | Theme | Rough window |
|-------|-------|--------------|
| 0 | Design, local env, accounts | Thu Jul 2 |
| 1 | Core app (accounting core, auth, customer invoices) + CI | Fri Jul 3 – Sat Jul 4 |
| 2 | Sync engine (QBO, idempotency, conflicts, retries) + CD | Sun Jul 5 – Tue Jul 7 |
| 3 | Terraform infra + deploy + hardening | Tue Jul 7 – Wed Jul 8 |
| 4 | Stretch / roadmap (vendor bills, refunds, reports) | beyond the 6-day target |

---

## Phase 0 — Design & foundations (`0000x`)

Complete — all tasks in `DONE.md`.

---

## Phase 1 — Core app + CI (`1000x`)

Goal: a working, locally-runnable app with auth and customer-invoice / payment
CRUD on a double-entry ledger, backed by Postgres, with CI green on every push.
CI is front-loaded (`10002`); from there **each task adds its own Vitest unit
tests** for the pure logic it introduces, rather than a separate testing task.

Core app (`10003`–`10011`) is complete in `DONE.md`. The `1001x` tasks below adapt
the existing `apps/web` UI to the **Clearbook design system** — see
[`docs/design-system.md`](../design-system.md) and the comp in
[`docs/design/clearbook/`](../design/clearbook). These are a **restyle, not a rewrite**:
all existing behaviour + tests stay green, the public SSG build still emits exactly the
3 prerendered pages, and Phase-2 sync surfaces are **not** built (see the design-system
"Phase-1 scope guards"). Each task is QA'd with Playwright (visual + behavioural). `10012`
is the foundation and blocks `10013`–`10017`.


---

## Phase 2 — Sync engine + CD (`2000x`)

Goal: real two-way sync against the QBO sandbox, safe under duplicate /
out-of-order events and partial failures, plus continuous deploy on merge to main.

### Deferred Phase-1 UI completions (do after the sync engine, or whenever there's a gap)

Two small features carved out of the `10012`–`10017` Clearbook restyle because each needs a
tiny **new backend endpoint** — intentionally kept out of the "restyle, no API change" sub-phase.
Neither depends on QBO sync; they can be pulled forward any time the schedule allows.

- ☐ `10019` **Customer edit** — add `PATCH /api/contacts/:id` (org-scoped update of displayName/email/phone, with a test) + a client `updateContact`, then wire the existing customers add-drawer (10017) for **edit** as well as create (prefill + save). The slide-over UI is already built; this only adds the update path.

---

## Phase 3 — Infrastructure as code + deploy (`3000x`)

Goal: reproducible **GCP** deployment via Terraform, wired to the CD pipeline, held under ~$30/mo.

> **AWS → GCP pivot (Jul 8).** The AWS infra + CD landed first (`30001`/`30011` + CD wiring,
> PR #44), but the AWS account was then blocked for compute, so the deploy target moved to
> **Google Cloud**: Cloud Run (API) + Cloud SQL (Postgres) + Artifact Registry + Secret Manager +
> Cloud Scheduler (retry sweep) + Firebase Hosting (web), with CI authenticating via Workload
> Identity Federation. The reasoning is written up in `docs/architecture-decisions.md` and
> `docs/design-decisions.md`; the implementation spec is `.claude/plans/gcp-migration.md`. The
> AWS-specific tasks below are **superseded** — kept for the record (their IDs are preserved), not
> as forward work. Their combined GCP replacement is `30012`.

**Superseded — AWS (delivered in PR #44, then replaced by the GCP stack in `30012`):**

- ⊘ `30001` Terraform: RDS Postgres, ECR, ECS cluster + Fargate service, VPC/networking, IAM task roles → Cloud SQL + Artifact Registry + Cloud Run.
- ⊘ `30002` Terraform: Route53 + EventBridge → Lambda DNS re-point on task-IP change → **dropped entirely**; Cloud Run has a stable HTTPS URL.
- ⊘ `30003` Terraform: S3 + CloudFront frontend, `/api/*` → Fargate → Firebase Hosting with an `/api/**` rewrite → Cloud Run.
- ⊘ `30005` Wire CD to the Terraform-managed ECR/cluster/service → CD now builds to Artifact Registry, migrates via a Cloud Run Job, and rolls the Cloud Run service.
- ⊘ `30009` / `30011` Bootstrap Terraform: GitHub **OIDC** provider + CD role → **Workload Identity Federation** pool/provider + deployer service account (`infra/bootstrap`).

**Done (GCP) — moved to `DONE.md`:** `30012` (AWS→GCP migration — deployed + verified live), `30013` (manual prod-seed workflow), `30014` (session cookie renamed `__session` so it survives Firebase Hosting's cookie stripping).

**Open (GCP):**

- ☐ `30004` Secrets: QBO client secret + webhook verifier token in **Secret Manager**, referenced by the Cloud Run service/job (DB URL, session secret, and sweep token are already generated + wired by `infra/terraform`; add the QBO pair under the same pattern + a matching accessor grant).
- ☐ `30006` End-to-end deploy verification against the QBO sandbox (on GCP).
- ☐ `30007` README/docs: setup, local run, test, and deploy instructions — **done** for the GCP migration (README, CLAUDE.md, architecture/design decisions, both infra READMEs updated); reopen only for post-deploy corrections.
- ☐ `30008` Final hardening + docs pass on tradeoff reasoning
- ☐ `30010` **Payment shouldn't make a synced invoice "locally dirty" (false-conflict on paid invoices)** — recording a payment runs `recomputeInvoice` (`apps/api/src/payments/service.ts:209`), which bumps the invoice's `transactions.version` **without** re-stamping its `sync_links.localVersion`. That leaves an already-synced invoice with `version > localVersion` (the 20010 "local-dirty" signal), so the next genuinely-newer QBO-side metadata edit on a paid / partially-paid invoice is flagged as a **conflict** and blocked in **both** directions instead of applying. Surfaced by the 20013 e2e suite (scenario 5(b)) — documented 20010 behavior, **not** a regression, deferred here as a hardening decision. Decide + implement one of: (a) have `recordPayment`/`recomputeInvoice` resync the invoice's `sync_links.localVersion` to the post-recompute `version` (a payment is not a syncable content edit, so it shouldn't dirty the sync link); or (b) let metadata-only inbound edits bypass the local-dirty check when the local dirtiness is payment-only. Add a regression test (extend `sync-engine.e2e.test.ts` scenario 5) proving a post-payment inbound metadata edit now **applies** rather than conflicting. Touches `apps/api/src/payments/service.ts`, `apps/api/src/qbo/conflict.ts` + `inbound-sync.ts`, and `apps/api/src/qbo/sync-link-service.ts`. Note the parallel private `recomputeInvoice` mirror in `inbound-sync.ts:666`.
- ☐ The invoice sync status shouldn't show: Synced and thenm Not yet synced to QuickBooks — two-way sync starts in a later phase. Integrations
- ☐ The client and invoice sync status should show synced (if its risky to change the quickbooks api calls just set it to `synced` when the when its tied to a synced invoice). It should also show a link to the quickbooks client, 
- ☐ `30015` **Inbound line/amount re-sync (QBO → local invoices)** — today `qboInvoiceToLocalPatch` ("decision #4" in `inbound-sync.ts`) applies only metadata inbound (docNumber/txnDate/dueDate/memo) and **structurally excludes line items + total**, so an amount edited in QBO never reaches the local ledger (verified live: a QBO due-date edit synced back, an amount edit did not). Extend inbound Update to also re-sync lines + total: map QBO `Line[]`/`TotalAmt` → local `transaction_lines`, then **re-post the ledger atomically** in the same `db.transaction` (zero the prior debit-A/R / credit-income entries via `zeroOutLedger`, re-post from the new lines), bumping `version` + `localVersion` so it doesn't re-loop. Guard: don't let a QBO total change drop below the already-applied paid amount — recompute `status`/`balance`, and if it would underflow a partially/fully-paid invoice, **flag it as a conflict** (reuse 20010's `sync_links.state='conflict'` + the conflicts UI) rather than force it. Per the design call: as long as each individual edit is itself balanced there's no ledger-integrity risk, so surface the genuine both-sides cases in the conflicts interface instead of over-engineering. Extend `sync-engine.e2e.test.ts` with a QBO amount-edit case proving the local ledger re-posts balanced. Touches `qbo/inbound-sync.ts`, `ledger/posting.ts`, `qbo/conflict.ts`.
- ☐ `30016` **Import invoices created in QuickBooks (inbound create + auto-link by QBO id)** — today an inbound event for a QBO invoice with no local link and no natural-key match is `skipped` (`no_match`/`create_deferred` — verified live: QBO-only invoice 147 was skipped). Implement inbound **create**: when a webhook references a QBO invoice that isn't linked and can't be natural-key-matched, create the local `customer_invoice` from the refetched QBO state — resolve/create the local contact from `CustomerRef`, map each `Line` → `transaction_lines`, post the balanced ledger, and write the `sync_links` row **keyed to the QBO id** so it's linked from then on. Must be idempotent (a redelivered webhook must not create twice — dedupe on the QBO id via the existing `event-dedup` + the `sync_links` unique). Decide line-account mapping (default Sales Income / A/R like local create, or map QBO `IncomeAccountRef` when resolvable). Closes the "pre-existing invoices only in QBO" PRD edge case beyond today's natural-key-link-only path. Extend `sync-engine.e2e.test.ts` (QBO-only invoice webhook → local invoice created + linked + balanced ledger; redelivery idempotent). Touches `qbo/inbound-sync.ts`, `invoices/service.ts`, `qbo/sync-link-service.ts`.

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
