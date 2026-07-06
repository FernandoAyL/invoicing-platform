# Design decisions

Domain and sync-engine design — the reasoning behind *how* the requirements in
[PRD.md](./PRD.md) are met. Platform and stack tradeoffs (runtime, framework,
database engine, deployment, tooling) live in
[architecture-decisions.md](./architecture-decisions.md); the concrete schema is
in the PRD's *Data model* section. This doc is the "why" for the data model and
the sync engine, and does not restate either of those.

## Data model

The books are a simplified double-entry ledger rather than a flat `invoices` +
`payments` pair. Two choices drive the shape:

- **One `Transaction` document table with a `type` discriminator**, instead of a
  table per document kind. QuickBooks exposes each kind as its own API entity
  (`Invoice`, `Bill`, `Payment`, `CreditMemo`, …), but they behave the same
  internally: a header, editable lines, and a set of GL postings. Collapsing them
  into one table makes a new document kind (vendor bill, refund, expense) a new
  enum value plus posting rules — not a new table, new CRUD, and a new sync path.
  The cost is that per-type invariants live in application logic rather than the
  table shape; acceptable for the range of documents planned.
- **Explicit `LedgerEntry` postings**, instead of deriving balances on the fly.
  Every `Transaction` writes a balanced set of debit/credit rows (Σ debit =
  Σ credit), so the general ledger is a first-class, queryable table and reports
  (General Ledger, Trial Balance, P&L, Balance Sheet) are read-only aggregations
  rather than bespoke per-document math. QuickBooks keeps this ledger internal and
  surfaces it only through reports; making it explicit is closer to how an
  accounting engine works under the hood, and the postings are far easier to test
  when they are real rows.

`Contact` unifies customer / vendor / employee into one party table with role
flags (QuickBooks splits them into three name lists); bank accounts and employee
credit cards are just `Account` rows with a `subtype`, not new tables. Both keep
the "new capability = additive, not a rewrite" property.

## Sync boundary

Sync happens at the **document level, not the ledger level.** Each system derives
its own general ledger from the documents it holds:

- Pushing a `customer_invoice` to QBO lets **QBO auto-post its own GL** (debit
  A/R, credit income); an inbound change makes **our** posting logic write our
  `LedgerEntry` rows. Ledger postings never cross the wire.
- Because each side derives its own ledger, our posting rules **mirror QBO's
  standard accounting behavior** for the same document, so the two ledgers stay
  equivalent without being reconciled directly. QBO remains the accounting system
  of record.
- Reference data a document points at (party, accounts, items) is mapped first,
  so both sides reference the same records.

| Entity | Synced? | Why |
|--------|---------|-----|
| `Contact` (customer / vendor) | **Yes** | Documents attach to a party; QBO needs the Customer/Vendor ID |
| `Account` (chart of accounts) | **Yes** | Lines and payments post to accounts; both sides must agree on which |
| `Item` | **Yes** | QBO requires an Item on invoice lines |
| `Transaction` (invoice / bill / payment / …) | **Yes** | The documents themselves — mapped to QBO's typed entity by `type` |
| `TransactionLine` | **Yes** | Travels inside its `Transaction` (embedded `Line[]` in QBO) |
| `LedgerEntry` | **No** | Internal only — each system derives its own general ledger from the documents |

The one exception: a manual `journal_entry` maps to QBO's `JournalEntry`, which
*does* carry explicit debit/credit lines — but that is still document-level sync
(a JournalEntry is a document), not syncing the internal `LedgerEntry` table. Out
of scope for the customer-invoice-first slice.

## QBO OAuth

Connecting to QBO is the one part of the sync engine that fundamentally can't be
driven by CI: it's a browser redirect through Intuit's own login. So the Intuit
token exchange/refresh/revoke calls sit behind a small `QboOAuthClient`
interface, injected into `buildApp(...)` the same way the DB pool is — tests pass
a stub and never touch the network, while the shape of the real HTTP calls
(Basic-auth header, form-encoded body, expiry math) is unit-tested separately
against a fake `fetch`. The real sandbox connect is a manual, user-run pass.

CSRF protection on the callback is a stateless signed `state` param (HMAC over
the existing session secret) rather than a server-side store — it carries the
org id and a timestamp, so a tampered, foreign-org, or stale token is rejected
without a lookup. The integration itself is optional: unset `QUICKBOOKS_*` env
vars leave `config.qbo` null and the connect/callback routes return `503`
instead of the app failing to boot. Connect/disconnect/status are admin-only,
matching "admin manages the QuickBooks connection" — the callback lands on the
admin's own browser request, so the same role check covers it.

Per-org OAuth tokens live in `QboConnection` in the app database, unencrypted;
that's a separate concern from the QBO *client secret*, which is a deploy-time
credential injected from AWS SSM Parameter Store and never touches this table.
`getValidAccessToken(orgId)` is the one primitive every later sync task calls
before talking to QBO — it refreshes and persists a new access token when the
stored one is null or within 60s of expiry, and throws a typed
"reconnect required" error rather than leaving a half-updated row if the
refresh itself fails.

## Mapping

`SyncLink` is entity-typed: it maps an internal record (`Contact` / `Account` /
`Item` / `Transaction`) to its QBO id + type. A document can't be pushed until the
party, accounts, and items it references are themselves linked, so mapping
resolves reference data first, then documents.

**Pre-existing records with no link.** When both systems already hold the same
customer or invoice with no `SyncLink`, the engine matches on natural keys (e.g.
doc number + amount + date for an invoice, email for a customer) and records a
link rather than creating a duplicate. Anything it can't confidently match
surfaces for a human to link — it is never blindly duplicated.

## Idempotency

Duplicate and retried events must never create duplicate records or repeated
writes — the core correctness requirement.

- **Inbound dedup:** every external event carries an id; the engine records
  processed event ids and drops repeats before any write.
- **Writes are upserts:** internal writes key on a stable idempotency key (or the
  mapped id) and use `ON CONFLICT`, so a replay updates in place instead of
  inserting.
- **Outbound safety:** before creating a QBO record the engine checks for an
  existing `SyncLink` / QBO match, so a retried create becomes a no-op or update.

## Ordering

Events arrive out of order. Each side carries a version / `updatedAt`; the engine
applies a change only if it is newer than what's recorded, and skips (but audits)
stale writes. This makes replay and reordering safe without locking the whole
invoice.

## Conflict resolution

The PRD states the policy (flag, don't guess); this is the mechanism. On each sync
the engine compares the last-synced version on both sides. If **both** changed
since the last successful sync, it does not merge or pick a winner — it marks the
invoice `conflict`, stops writing that invoice in either direction, and requires a
user to choose the winning version. **Last-write-wins was rejected**: it silently
loses one side's edits, which for financial records is worse than a visible stop.

## Delete vs void

QuickBooks distinguishes **void** (keeps the record, zeroes its amounts) from
**delete** (removes it). The engine preserves the distinction rather than
collapsing both to one action — they have different accounting meaning: a voided
invoice still exists in the audit trail, a deleted one does not. A void syncs as a
void, a delete as a delete.

## Failure handling

External calls fail, time out, or partially apply.

- **Incomplete payloads:** a webhook may omit fields; when detected, the engine
  refetches full state from QBO before applying, rather than persisting a partial
  record.
- **Retry with backoff:** transient failures retry with exponential backoff; a
  failed item lands in a retryable state visible in the Integrations log for
  manual retry.
- **Partial success after a write:** a write that times out may have landed. The
  engine does not blindly re-issue — it refetches / checks the idempotency key to
  determine whether the write took, then completes or retries safely.

## Auditability

Every mutating and sync action appends to `SyncAuditLog` (entity, action,
direction, outcome, timestamp, triggering event). It is append-only, so the
history explains what changed, what action was taken, and whether it succeeded —
the basis for both the Integrations activity log and debugging a divergence.

## Deploy and IaC boundary

Two ownership lanes, and **no Terraform in the deploy path**:

- **Terraform owns infrastructure** — RDS, ECR, the ECS cluster/service, VPC,
  Route53/EventBridge/Lambda, CloudFront, secrets. Run deliberately (locally for
  this project) on the rare stack change.
- **GitHub Actions owns app deploys** — on merge to `main`: build the image, push
  to ECR, register a new task-definition revision, and update the Fargate service.

Rationale: it keeps CI's blast radius tiny (the pipeline can roll the app but not
create or destroy infrastructure), makes deploys fast (no `terraform apply` per
merge), and matches the "no unnecessary standing infrastructure" stance — the
DNS re-point on task-IP change is already automated by the EventBridge → Lambda
rule, so CD never touches Route53 either.

**Avoiding image-tag drift.** If Terraform managed the task definition's image
tag, a CI-driven image change would show as drift and the next `apply` would try
to revert it. So Terraform stands up the service with an initial task def but
`lifecycle { ignore_changes = [task_definition, desired_count] }`; CI owns every
revision after that. Clean ownership boundary, no tug-of-war over the tag.

**CI identity.** GitHub Actions assumes an AWS role via **OIDC** (no long-lived
access keys), trust-scoped to this repo on `main`. Its permissions are limited to
ECR push, `ecs:RegisterTaskDefinition`, `ecs:UpdateService`, and `iam:PassRole` —
nothing that can touch Terraform state or provision infrastructure.

**Migrations** run as a one-off `aws ecs run-task` with the new image *before* the
long-running service is updated, so a failed migration fails the deploy before
traffic reaches new code.

*Not adopted, but noted:* running Terraform in CI (`plan` on PR, `apply` on merge)
buys reviewed/audited infra changes and avoids laptop-state/cred drift — worth it
for a team or multiple environments, overkill for a single-environment solo
deploy. A cheap middle ground is a read-only `terraform plan` on infra PRs while
still applying locally.
