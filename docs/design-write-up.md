# Design write-up — two-way invoice sync

A concise tour of how the service keeps an internal invoicing system and **QuickBooks Online (QBO)**
in sync in both directions — safely, under duplicate/out-of-order events and partial failure. This is
the summary; the "why" behind each decision lives in [`PRD.md`](./PRD.md),
[`design-decisions.md`](./design-decisions.md), and [`architecture-decisions.md`](./architecture-decisions.md).

## What the service does

The business creates and edits invoices, records payments, and voids/deletes documents in an internal
system backed by a double-entry ledger (Postgres, system of record). QBO is the accounting system of
record on the other side. Changes made on **either** side are propagated to the other automatically,
without double entry and without silent data loss when both sides are edited concurrently.

Both directions run through one small engine (`apps/api/src/qbo/`):

- **Outbound** (`outbound-sync.ts`): a local create/update/void/delete is pushed to QBO best-effort
  *after* its own DB transaction commits — a network call never holds a DB transaction open.
- **Inbound** (`inbound-sync.ts` + `routes/qbo-webhook.ts`): a QBO webhook carries only
  `{name, id, operation}`, so the engine **refetches** the authoritative full record
  (`refetch.ts`) before applying, because webhook payloads are incomplete.

## The six pillars

| Requirement | Mechanism | Where |
|---|---|---|
| **1. Mapping** | A `sync_links` row maps each local entity ⇄ its QBO counterpart, keyed both ways with unique constraints `(orgId, entityType, localId)` and `(orgId, qboType, qboId)`. The domain is a unified double-entry ledger — one `transactions` table (invoice/payment/…), `transaction_lines`, `ledger_entries` (debit/credit), `payment_applications` (payment↔invoice N:N), and a chart of `accounts`. | `sync-link-service.ts`, `db/schema.ts` |
| **2. Sync logic** | Ingest from either side → refetch current state as needed → apply safely to the other. Reference-data-first and `synced`-gated on the way out (a document's contact/accounts must be linked before it pushes); refetch-then-apply on the way in. | `inbound-sync.ts`, `outbound-sync.ts`, `refetch.ts` |
| **3. Idempotency** | Inbound events are deduped on `(realm, entity, id, operation, lastUpdated)` via `processed_events`, claimed **in the same transaction** as the apply so a crash mid-apply looks like "never claimed" and is safely re-driven. Writes are idempotent by construction: a link with a `qboId` means UPDATE (never a second CREATE); natural-key + `sync_links` uniques prevent duplicate records. | `event-dedup.ts`, `idempotency-key.ts`, `natural-key.ts` |
| **4. Conflict handling** | When a record changed on **both** sides since the last sync (local `version > sync_links.localVersion` **and** the incoming QBO change is genuinely newer), the link is flagged `state='conflict'`, **both** directions stop writing it, and a human resolves it (`/conflicts` UI, `winner: local \| qbo`). Last-write-wins is deliberately rejected for financial records. | `conflict.ts`, `routes/conflicts.ts` |
| **5. Auditability** | Every mutating action — local, inbound, outbound — appends an immutable `sync_audit_logs` row (entity, action, direction, outcome, triggering event, actor, timestamp), written atomically with the change. Surfaced in the Integrations activity log. | `audit/service.ts`, `routes/sync-activity.ts` |
| **6. Failure handling** | Outbound failure never fails the local write; it marks the link `failed` with backoff bookkeeping. A background sweep retries due links with exponential backoff (30s→cap 1h, terminal after 8 attempts) and, before re-CREATE, reconciles by natural-key query so a landed-but-unlinked write links instead of duplicating. Failed items are visible for manual retry. | `retry.ts`, `retry-sweep.ts`, `routes/sync-failures.ts` |

## Edge-case coverage

All eight of the messy cases are handled and covered end-to-end in
`apps/api/src/__tests__/sync-engine.e2e.test.ts` (driven through the real signed-webhook route, the
HTTP routes, and the retry sweep against real Postgres via pglite, with injectable fake QBO clients),
backed by focused unit tests per module.

| Edge case | How it's handled | Covered |
|---|---|---|
| **Duplicate webhook delivery** | `processed_events` claim inside the apply transaction → byte-identical redelivery is a no-op with one `qbo.webhook.duplicate` breadcrumb. | ✅ e2e §1 + `event-dedup.test.ts` |
| **Out-of-order events** | Ordering guard compares QBO `SyncToken` (then `LastUpdatedTime`) against what the link recorded; a stale delivery is skipped **without** downgrading the stored token, a genuinely-newer one applies. | ✅ e2e §2 + `ordering.test.ts` |
| **Same invoice edited in both systems** | Both-sides-changed detection flags a `conflict`, applies neither side, and blocks the next outbound push — surfaced for human resolution. | ✅ e2e §3 + `conflict.test.ts` |
| **Delete vs void** | Kept as distinct local states: inbound Void zeroes the ledger + flips `status='void'` (record kept, still readable); inbound Delete **soft-deletes** (`deletedAt`, invisible to reads) without touching `status`. Neither collapses into the other, and a later event never resurrects a deleted record. | ✅ e2e §4 |
| **Partially-paid invoice edited** | A local edit of a partially/fully-paid invoice is rejected (`409`); a subsequent genuinely-newer inbound metadata edit is **conflict-flagged** rather than silently overwriting the payment-affected ledger (the recorded payment left the invoice locally-dirty). The ledger is protected in both directions. | ✅ e2e §5 |
| **Timeout after write to an external system** | A CREATE that landed at QBO but whose local link write was lost leaves a `failed`, `qboId=null` link while the QBO entity exists — the state a naive retry would double-create from. | ✅ e2e §6 |
| **Retry after partial success** | The sweep reconciles via a natural-key query and **links** the already-existing QBO entity instead of creating a second one; a plain transient failure recovers on a later tick with exactly one successful create. | ✅ e2e §7 |
| **Existing invoices in both systems, no linkage** | An inbound event for an unlinked QBO invoice: a confident **natural-key match** links the existing local invoice (no duplicate); an **ambiguous** match is skipped for a human (never guessed); and a QBO invoice with **no local counterpart at all** is now **imported** — the local invoice is created from refetched state, its contact resolved/created from `CustomerRef`, a balanced ledger posted, and it's linked keyed to the QBO id (idempotent on redelivery). | ✅ e2e §8 (match/ambiguous) + §9 (import) |

## Notable tradeoffs

- **Explicit conflict flagging over last-write-wins.** For money, silently letting one side clobber the
  other is the wrong default; genuine both-sides edits stop and wait for a decision.
- **Best-effort outbound, decoupled from the request.** The user's local write never fails because QBO
  is down; durability comes from the `failed`-link + retry-sweep loop instead.
- **Refetch-then-apply inbound.** Webhooks are treated as "something changed" signals, not as data —
  the authoritative record is always refetched, so incomplete/delayed payloads can't corrupt state.
- **Soft delete, immutable ledger.** Deletes set `deletedAt` and ledger corrections post reversing
  entries (never UPDATE/DELETE rows), preserving the reconciliation/idempotency trail.
- **Current inbound-update boundary.** Inbound Update re-syncs metadata + void/delete + payment effects
  + first-time import; full inbound **line/amount** re-sync (re-posting the ledger for a QBO-side amount
  edit) is the documented next step (backlog `30015`). Because the metadata path never touches amounts,
  it can never unbalance the ledger.

## Status & verification

Deployed on Google Cloud Run (API) + Cloud SQL + Firebase Hosting, with CI gating every push
(typecheck, Biome, type-strippability smoke, `docker build`, and both apps' test suites). The sync
engine was validated against a **real QBO sandbox** connection — which is how the live-only
lowercase-URL-segment fault (`20016`) was found and fixed; CI itself runs against injected fake QBO
clients by design (no live Intuit calls in CI).
