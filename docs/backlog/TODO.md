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

- ☐ `20006` Outbound sync: propagate internal create/edit/void of invoices and payments to QBO
- ☐ `20007` Inbound sync: apply QBO-originated changes to internal records
- ☐ `20008` Ordering: handle out-of-order events (version/updated-at guards, skip stale writes)
- ☐ `20009` Delete-vs-void: treat delete and void as distinct actions matching QBO semantics
- ☐ `20010` Conflict detection + policy: flag invoices edited in both systems since last sync as `conflict`, no silent overwrite; resolution UI to pick the winning version
- ☐ `20011` Failure handling: retry with backoff, safe recovery from partial success (timeout after a write), failed-item state for manual retry
- ☐ `20012` Integrations page: connect/disconnect QBO, connection health, chronological sync activity log, manual retry of a failed item
- ☐ `20013` Sync engine tests: duplicate webhook, out-of-order, edited-in-both, delete-vs-void, partially-paid edit, timeout-after-write, retry-after-partial-success, pre-existing unlinked invoices

### Deferred Phase-1 UI completions (do after the sync engine, or whenever there's a gap)

Two small features carved out of the `10012`–`10017` Clearbook restyle because each needs a
tiny **new backend endpoint** — intentionally kept out of the "restyle, no API change" sub-phase.
Neither depends on QBO sync; they can be pulled forward any time the schedule allows.

- ☐ `10018` **Invoice-detail ledger-postings card** — add an org-scoped `GET /api/invoices/:id/ledger` read over the existing `LedgerEntry` rows (with a unit test), then render the debit/credit postings card on `routes/InvoiceDetail.tsx` (the comp shows it; 10016 deferred it rather than fake the rows). Read-only; no posting logic changes.
- ☐ `10019` **Customer edit** — add `PATCH /api/contacts/:id` (org-scoped update of displayName/email/phone, with a test) + a client `updateContact`, then wire the existing customers add-drawer (10017) for **edit** as well as create (prefill + save). The slide-over UI is already built; this only adds the update path.

---

## Phase 3 — Infrastructure as code + deploy (`3000x`)

Goal: reproducible AWS deployment via Terraform, wired to the CD pipeline.

- ☐ `30001` Terraform: RDS Postgres, ECR repo, ECS cluster + Fargate service (with `lifecycle.ignore_changes = [task_definition, desired_count]` so CD owns image revisions without drift), VPC/networking, IAM task roles
- ☐ `30002` Terraform: Route53 record + EventBridge rule on ECS task-state-change → Lambda updating DNS to the task's public IP
- ☐ `30003` Terraform: S3 bucket + CloudFront distribution for the frontend, `/api/*` origin → Fargate
- ☐ `30004` Secrets: QBO client secret and DB creds in SSM Parameter Store / Secrets Manager, injected into the task
- ☐ `30005` Wire CD (`20014`) to the Terraform-managed ECR/cluster/service: Terraform provides only the initial task def, CD registers revisions + updates the service; DB migrations run as a pre-deploy `aws ecs run-task`
- ☐ `30009` Terraform: GitHub OIDC identity provider + narrow CD role — trust scoped to `repo:FernandoAyL/invoicing-platform` on `main`; permissions limited to ECR push, `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, `iam:PassRole`
- ☐ `30006` End-to-end deploy verification against the QBO sandbox
- ☐ `30007` README: setup, local run, test, and deploy instructions
- ☐ `30008` Final hardening + docs pass on tradeoff reasoning

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
