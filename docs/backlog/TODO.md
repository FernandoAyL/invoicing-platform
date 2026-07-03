# TODO

Backlog of planned work, grouped into phases. The developer moves a task out of
here to `TOTEST.md` once implemented; on QA pass the planner moves it to
`TOCODEREVIEW.md`, and on review approval to `DONE.md`. A QA or review rejection
sends the task back here with the findings attached as a sub-bullet.

**Task IDs** are prefixed by phase: Phase 0 → `0000x`, Phase 1 → `1000x`,
Phase 2 → `2000x`, Phase 3 → `3000x`.

**Timeline** — target deploy end of day **Wed Jul 8** (~6 days from Thu Jul 2).

| Phase | Theme | Rough window |
|-------|-------|--------------|
| 0 | Design, local env, accounts | Thu Jul 2 |
| 1 | Core app (data model, auth, invoices) + CI | Fri Jul 3 – Sat Jul 4 |
| 2 | Sync engine (QBO, idempotency, conflicts, retries) + CD | Sun Jul 5 – Tue Jul 7 |
| 3 | Terraform infra + deploy + hardening | Tue Jul 7 – Wed Jul 8 |

---

## Phase 0 — Design & foundations (`0000x`)

Design docs are already written and committed (see `DONE.md`). Remaining setup:

- ☐ `00005` Register QuickBooks Online developer account and create a sandbox company
- ☐ `00006` Create QBO app: obtain OAuth client id/secret, configure redirect URIs and webhook endpoint
- ☐ `00007` AWS account + IAM user/role for Terraform; configure local credentials and a remote state backend (S3 + DynamoDB lock)
- ☐ `00008` Local dev env: `docker-compose` running Postgres + the app on Node 24
- ☐ `00009` Repo scaffolding: pnpm workspace, `tsconfig`, lint/format, `.env` config loader, `packageManager` pin

---

## Phase 1 — Core app + CI (`1000x`)

Goal: a working, locally-runnable invoicing app with auth and invoice/payment
CRUD, backed by Postgres, with CI green on every push.

- ☐ `10001` Drizzle schema + first migration: `Organization`, `User`, `Customer`, `Invoice`, `Payment`, `QboConnection`, `SyncLink`, `SyncAuditLog`
- ☐ `10002` Fastify server bootstrap: config, Postgres pool plugin, pino structured logging, health endpoint
- ☐ `10003` Auth: email/password session login, httpOnly cookie, logout, seeded users, Admin/Member roles
- ☐ `10004` Customer CRUD (name, contact info) — the minimal record attachable to an invoice
- ☐ `10005` Invoice CRUD: create / edit / void, attach customer, invoice line items
- ☐ `10006` Payments: record a payment against an invoice, derive paid/partial/unpaid status
- ☐ `10007` Audit log write path: every mutating action appends to `SyncAuditLog` (entity, action, direction, outcome, user, timestamp)
- ☐ `10008` Frontend scaffold: React/Vite single app, public SSG routes (`/`, `/products`, `/pricing`), client-rendered auth routes
- ☐ `10009` Dashboard + invoice list/detail UI with inline sync status badge (synced / pending / conflict / failed)
- ☐ `10010` CI (GitHub Actions): install (pnpm fetch), lint, `tsc --noEmit`, vitest, build, docker build
- ☐ `10011` Unit tests: data model constraints, invoice state transitions, payment status derivation

---

## Phase 2 — Sync engine + CD (`2000x`)

Goal: real two-way sync against the QBO sandbox, safe under duplicate /
out-of-order events and partial failures, plus continuous deploy on merge to main.

- ☐ `20001` QBO OAuth: connect/disconnect flow, token storage in `QboConnection`, automatic token refresh
- ☐ `20002` Webhook ingestion endpoint: JSON-schema validation of inbound QBO payloads (Fastify schema), signature verification
- ☐ `20003` Refetch: when a webhook payload is incomplete, fetch full invoice/payment state from QBO before applying
- ☐ `20004` Mapping layer: `SyncLink` resolution between internal invoice/payment IDs and QBO IDs, including GL accounts
- ☐ `20005` Idempotency: event dedup by external event id, idempotency keys on writes, `ON CONFLICT` upserts — no duplicate records or repeated writes
- ☐ `20006` Outbound sync: propagate internal create/edit/void of invoices and payments to QBO
- ☐ `20007` Inbound sync: apply QBO-originated changes to internal records
- ☐ `20008` Ordering: handle out-of-order events (version/updated-at guards, skip stale writes)
- ☐ `20009` Delete-vs-void: treat delete and void as distinct actions matching QBO semantics
- ☐ `20010` Conflict detection + policy: flag invoices edited in both systems since last sync as `conflict`, no silent overwrite; resolution UI to pick the winning version
- ☐ `20011` Failure handling: retry with backoff, safe recovery from partial success (timeout after a write), failed-item state for manual retry
- ☐ `20012` Integrations page: connect/disconnect QBO, connection health, chronological sync activity log, manual retry of a failed item
- ☐ `20013` Sync engine tests: duplicate webhook, out-of-order, edited-in-both, delete-vs-void, partially-paid edit, timeout-after-write, retry-after-partial-success, pre-existing unlinked invoices
- ☐ `20014` CD (GitHub Actions): on merge to `main`, build image → push to ECR → update Fargate service (auto-update on main)

---

## Phase 3 — Infrastructure as code + deploy (`3000x`)

Goal: reproducible AWS deployment via Terraform, wired to the CD pipeline.

- ☐ `30001` Terraform: RDS Postgres, ECR repo, ECS cluster + Fargate service, VPC/networking, IAM task roles
- ☐ `30002` Terraform: Route53 record + EventBridge rule on ECS task-state-change → Lambda updating DNS to the task's public IP
- ☐ `30003` Terraform: S3 bucket + CloudFront distribution for the frontend, `/api/*` origin → Fargate
- ☐ `30004` Secrets: QBO client secret and DB creds in SSM Parameter Store / Secrets Manager, injected into the task
- ☐ `30005` Wire CD (`20014`) to Terraform-managed ECR/service; run migrations on deploy
- ☐ `30006` End-to-end deploy verification against the QBO sandbox
- ☐ `30007` README: setup, local run, test, and deploy instructions
- ☐ `30008` Final hardening + docs pass on tradeoff reasoning
