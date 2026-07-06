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

## QBO webhook ingestion

`POST /api/integrations/qbo/webhook` is the sync engine's inbound edge:
receive → verify → validate → resolve entity type → refetch → claim (dedup) →
apply. The refetch/claim/apply stages are 20007; see Idempotency, Mapping, and
Failure handling below for how each works.

**Signature over the raw body.** Intuit signs the exact request bytes
(`intuit-signature: base64(HMAC-SHA256(rawBody, verifierToken))`), so the
signature has to be checked before the body is parsed — re-serializing a parsed
object and hashing that would not reproduce the same bytes Intuit signed. This
is done in a Fastify content-type parser registered inside the webhook route's
own plugin scope, so only this route's JSON parsing is intercepted; every other
route keeps using Fastify's default global `application/json` parser
untouched. The verifier token is a separate secret from the OAuth client secret
(Intuit issues it independently under the app's Webhooks settings) and is
injectable the same way `QboOAuthClient` is, so tests compute a valid signature
against a known token without touching the network.

**Fails closed.** No verifier token configured → `503`, never "accept
anything" as a fallback — an unsigned webhook must never be trusted in a
financial system, dev included.

**Public, but the signature is the auth.** Intuit calls this with no session
cookie, so the route carries no admin/session gate; the signature check is the
only gate.

**Realm resolution and ack-fast.** Each notification carries a `realmId`,
resolved to the owning org via `QboConnection`. An unresolvable realm is
`200`-acked and logged, not errored — Intuit retries non-2xx responses, and a
stray/foreign realm must not trigger a retry storm. Genuinely malformed
input (bad signature, unparseable JSON, wrong shape) is rejected with
`401`/`400` since those are real client-side bugs, not business conditions.

**Every entity gets exactly one inbound audit row** (`direction: inbound`,
`qbo.inbound.*`/`qbo.webhook.*` action, `success`/`skipped`/`failure`
outcome) under the resolved org — the same audit trail every other sync
action appends to (see Auditability below). An entity name
`mapNotificationToEntityType` doesn't recognize (e.g. `Preferences`) writes a
`qbo.webhook.unmapped`/`skipped` row and is never claimed (nothing to
retry). Everything else — refetch, claim, and apply — is described in
Idempotency, Mapping, and Failure handling below.

## QBO data-API read client + refetch

Webhook notifications from QBO carry only `{ name, id, operation }` — never the
full record — so **inbound sync always refetches** the authoritative entity
before applying anything. `QboApiClient` (`GET
/v3/company/{realmId}/{entityType}/{qboId}?minorversion=...`, `Authorization:
Bearer`, base URL switched on `config.qbo.environment`) is injectable the same
way `QboOAuthClient` is, so tests supply a fake instead of hitting Intuit.
`refetchEntity` composes it with `getValidAccessToken` (refreshing the access
token on-demand if it's near expiry) to return the current entity state for a
given org + type + QBO id — the one primitive the mapping (`SyncLink`
resolution) and inbound-apply tasks both call rather than trusting whatever
partial fields a notification happened to include.

**Typed error taxonomy**, so later failure-handling logic (see Failure
handling below) can branch without string-matching: `QboAuthError` (401 — the
token was rejected despite looking fresh; distinct from "no connection" and
means "reconnect"), `QboNotFoundError` (404 — the entity is gone from QBO,
interpreted downstream as delete semantics), and `QboApiError` (everything
else non-2xx, plus a malformed/empty 200 body) carrying a `retryable` flag —
true for 429/5xx (transient, back off and retry), false otherwise (a bad
request shape won't succeed on retry). This task only classifies; it does not
retry — that's the failure-handling task's job.

**Extended to writes in 20006.** `QboApiClient` gained `createEntity` (POST
`/v3/company/{realmId}/{entityType}`), `updateEntity` (same path, sparse body
with `Id`/`SyncToken`), and `voidEntity` (same path + `?operation=void`),
sharing the same base-URL/auth-header/error-mapping plumbing as `getEntity`
(one `parseResponse` helper classifies every response, read or write). Still
fully injectable — outbound-sync's automated tests use a fake write client
that tracks calls and returns incrementing `Id`/`SyncToken` pairs, so no test
ever reaches live Intuit.

## Mapping

`SyncLink` is entity-typed: it maps an internal record (`Contact` / `Account` /
`Item` / `Transaction`) to its QBO id + type. A document can't be pushed until the
party, accounts, and items it references are themselves linked, so mapping
resolves reference data first, then documents.

**`entityType` -> `qboType` derivation (`resolveQboType`, `qbo/sync-link-service.ts`).**
A pure function, no DB access: `contact` -> `Customer`, `account` -> `Account`,
`item` -> `Item`. `transaction` is a many-to-one split on the local
`Transaction.type` since one internal table backs several QBO document types —
`customer_invoice` -> `Invoice`, `payment` -> `Payment` today. Any other
transaction type (`journal_entry`, `vendor_bill`, `expense`, ...) has no mapping
yet and throws `UnmappableEntityError`; that's Phase 4 territory, not a bug.

**The `SyncLink` resolution service** (`qbo/sync-link-service.ts`) is the DB-backed
half: `findLinkByLocal` / `findLinkByQbo` (org-scoped lookups by either side of
the mapping), `upsertLink` (idempotent write — select-then-branch inside a
`db.transaction`, mirroring the `upsertConnection` pattern in
`connection-service.ts`), and `setLinkState` / `markSynced` / `markConflict` /
`markFailed` (state-transition helpers). `upsertLink` enforces both of
`sync_links`' unique constraints at the application level before they'd ever hit
Postgres: relinking the same local record to a *different* QBO id, or relinking
a QBO id already claimed by a *different* local record, both throw
`ConflictingLinkError` rather than silently overwriting the existing link (or
crashing on the unique-constraint violation) — a conflicting link is always a
decision a human needs to make, never an automatic relink. Calling `upsertLink`
twice with the *same* local <-> QBO pair is a no-op update (one row, not two) —
this is what makes outbound "check for an existing link before creating"
idempotent (see Idempotency below).

**`resolveTransactionDeps`** is a read-only dependency **report**, not an
executor: given a transaction id, it loads the transaction + its lines, collects
the referenced contact and the distinct line accounts/items, looks up each
one's link, and returns `{ contact, accounts, items, allLinked, unlinked }`.
`allLinked` gates whether the outbound push (a later task) is allowed to push
the document yet; `unlinked` names exactly what still needs linking first. It
does not push anything to QBO or write any link itself — reference-data-first
is enforced by the *caller* consulting this report, not by this function acting
on QBO's behalf.

**Pre-existing records with no link.** When both systems already hold the same
customer or invoice with no `SyncLink`, the engine matches on natural keys (e.g.
doc number + amount + date for an invoice, email for a customer) and records a
link rather than creating a duplicate. Anything it can't confidently match
surfaces for a human to link — it is never blindly duplicated.

**Natural-key matchers** (`qbo/natural-key.ts`) are pure — no DB, no QBO fetch.
They take a local record and a list of *already-fetched* QBO candidates (fetching
candidates needs QBO's query API, which is out of scope here and deferred to the
inbound/reconciliation tasks) and return one of three outcomes: `{ kind: 'match',
qboId }`, `{ kind: 'none' }`, or `{ kind: 'ambiguous', candidates }`. Ambiguous
never auto-links — it's surfaced for a human (the Integrations page renders this
queue in a later task).

- `matchContactByNaturalKey`: when the local contact has an email, the match is
  decided on normalized (trimmed, case-insensitive) email alone — it does *not*
  fall back to display name just because the email didn't match anything, since
  two unrelated contacts can share a display name but not an email. Only when the
  local contact has *no* email does display name decide. Either path: zero
  candidates -> `none`, exactly one -> `match`, more than one (e.g. two QBO
  customers sharing an email) -> `ambiguous`.
- `matchInvoiceByNaturalKey`: with a `docNumber`, a confident match requires the
  same `docNumber` *and* the same total *and* the same `txnDate`. Without a
  `docNumber` (doc number alone can't disambiguate), it requires total + date +
  the invoice's customer (by the customer's already-resolved QBO id) to all
  agree — and returns `none` (not a guess) when the local invoice's customer link
  isn't known yet. Money is always compared as integer cents via the existing
  `toCents` helper, never by float equality (`'100.00'` matches `100` but not
  `100.01`).

**Inbound apply (`qbo/inbound-sync.ts`, 20007)** is `applyInboundEntity(tx,
input)` — called by the webhook route with the SAME `tx` the dedup claim used
(see Idempotency below), and the already-refetched QBO entity. Scope is
Invoice + Payment + Customer-linking only; Account/Item notifications (and
any `Merge`/`Emailed` operation, on any entity) are recorded as a
`qbo.inbound.skip` no-op.

- **Linked, by `findLinkByQbo`:** `Update` (or a redelivered `Create` that
  landed on an already-linked id) patches the local record's metadata and
  calls `markSynced` with the refetched `SyncToken`; `Void`/`Delete` both void
  the local record (the delete-vs-void semantic split is 20009 — until then,
  an inbound delete is just a void here). An inbound update on an
  already-locally-voided record is a no-op skip — it never un-voids (real
  conflict handling, i.e. flagging that both sides changed, is 20010).
- **Unlinked:** attempts a natural-key link using the 20004 matchers —
  `loadContactCandidates`/`loadInvoiceCandidates` (`qbo/inbound-sync.ts`) load
  every not-yet-linked local Contact/Invoice in the org (excluding rows a
  *different* `sync_links` row already claims) as candidates. Because
  `matchContactByNaturalKey`/`matchInvoiceByNaturalKey` were built for the
  *outbound* direction (one local record vs many already-fetched QBO
  candidates, returning the winning candidate's `qboId`), inbound reverses the
  roles: the refetched QBO entity plays the matcher's "local" argument, and
  each local candidate's own id rides through the matcher's `qboId` field
  (never interpreted, only echoed back) — so a `{kind:'match', qboId}` result
  is read as "this local id matched". A `match` calls `upsertLink` (state
  `synced`) and then applies the same metadata patch as the linked path; a
  `none`/`ambiguous` result writes a `qbo.inbound.skip` audit and creates no
  link — never auto-created, never guessed, surfaced for a human (20012). A
  `Create` operation with no natural-key match gets a distinguishable
  `no_match:create_deferred` reason in the audit detail (see "Deferred
  inbound create" below). `Void`/`Delete` of an unlinked entity is a skip —
  there's no local record to void. No natural-key matcher exists for Payment
  (20004 only built Contact/Invoice matchers), so an unlinked inbound Payment
  is always a documented skip regardless of operation.
- **Customer is linking-only.** A linked Customer `Update` only refreshes the
  link's `SyncToken` — the Contact row's own fields (`displayName`, `email`,
  …) are never patched from QBO in this task, matching the "keep apply to
  Invoice + Payment (+ Customer linking)" scope. A Customer `Void`/`Delete`
  has no local equivalent (a Contact has no void state) and is a documented
  skip either way.
- **Content-update depth (the scope boundary for this task).** A linked
  Invoice `Update` patches only `DocNumber`/`TxnDate`/`DueDate`/`PrivateNote`
  — QBO-side **line/amount edits are not re-synced** here (that would mean
  reverse-mapping every `ItemRef`/`AccountRef` back to a local item/account
  and re-running `zeroOutLedger`+`postLedger`, which was too large a scope for
  this task on top of the transactional-claim-plus-apply fix). Because
  amounts/lines are never touched by this path, the ledger is never put out
  of balance by it — the boundary is conservative by construction, not just
  by convention. A linked Payment `Update` is metadata-only the same way
  (`TxnDate`/`PrivateNote`); a Payment's *amount* effect on its invoice is
  only ever changed via the `Void`/`Delete` path, which removes the
  `payment_applications` row, zeroes the payment's ledger postings, and
  recomputes the invoice's `status`/`balance` from its remaining applied
  payments (mirroring `payments/service.ts`'s recompute, kept as a small
  local copy in `inbound-sync.ts` since the inbound context has no
  `PaymentContext`/user actor to reuse the exported route-level helpers
  with). Re-syncing line-level edits and adding an ordering/stale-skip guard
  around them is follow-up work (20008 territory once this boundary is
  revisited).
- **Deferred inbound create.** Materializing a QBO-originated Invoice/Contact
  as a *brand-new* local row (an inbound `Create` with no natural-key match)
  is explicitly out of scope — it would mean reverse-mapping every reference
  (customer, items, accounts) and rebuilding ledger postings for a document
  this system has never seen. Rather than silently dropping it, it's recorded
  as a `qbo.inbound.skip` audit with reason `no_match:create_deferred` (a
  `Create` is not privileged over any other unmatched operation — the row
  just carries a more specific reason string for the eventual Integrations
  "needs manual linking/creation" queue, 20012).

**Outbound push (`qbo/outbound-sync.ts`, 20006)** is the writer that consumes
`resolveTransactionDeps`'s report and `upsertLink`'s idempotent write: after
`invoices/service.ts` / `payments/service.ts` commit their own
`db.transaction`, the matching route calls `syncInvoiceOutbound` /
`syncPaymentOutbound` **best-effort, post-commit** — a QBO network call never
holds a local DB transaction open, and an outbound failure never rolls back or
fails the local write/HTTP response (the retry loop over `failed` links is
20011, out of scope here). Reference-data-first is enforced here, not just
reported: `ensureEntitySynced` pushes the contact and every distinct line
account/item **only when their `SyncLink` isn't already `synced`** — a
`pending`/`failed` ref link does not satisfy the gate, so it's (re)pushed
before the document, closing the 20004 review note that `allLinked` alone
(any link, any state) wasn't a strict enough gate. For a payment's applied
invoice(s), the equivalent gate (`ensureInvoiceSynced`) reuses
`syncInvoiceOutbound` itself rather than duplicating the ref-gating/
create-vs-update logic a second time.

## Idempotency

Duplicate and retried events must never create duplicate records or repeated
writes — the core correctness requirement.

- **Inbound dedup:** QBO webhooks carry no globally-unique event id, so the
  engine derives one: `buildEventKey` (`qbo/event-dedup.ts`) builds the tuple
  `realmId:name:id:operation:lastUpdated`, falling back to the 4-tuple
  (dropping `lastUpdated`) when QBO omits it. A genuine re-edit gets a new
  `lastUpdated` and is therefore a new event; a redelivery repeats the same
  tuple and is a duplicate. `recordEventIfNew` records the key in the
  `processed_events` table (unique on `(org_id, event_key)`) via a single
  `INSERT ... ON CONFLICT (org_id, event_key) DO NOTHING RETURNING id` —
  atomic check-and-record, no separate SELECT race, so two concurrent
  redeliveries of the same event can never both "win". It returns `true`
  (process) on first delivery, `false` (skip) on every redelivery.
- **Claim + apply are now atomic (the gap 20005's review flagged, closed by
  20007).** Before 20007 there was nothing to apply, so the claim
  (`recordEventIfNew`) and the receipt audit write were two statements
  against the top-level `db` — harmless while nothing was being mutated, but
  once an *apply* exists, a crash between "claim recorded" and "apply
  written" would have silently dropped the change (the claim survives, so
  Intuit's redelivery would be deduped away and never retried). The webhook
  route (`routes/qbo-webhook.ts`) now restructures per entity into two
  phases: **(a) refetch** the full QBO entity via `refetchEntity`
  (`qbo/refetch.ts`) — a network call, always OUTSIDE any transaction —
  then **(b) one `db.transaction(tx => ...)`** that calls
  `recordEventIfNew(tx, …)` and, only if it returns `true`, calls
  `applyInboundEntity(tx, …)` (`qbo/inbound-sync.ts`) to mutate the local
  record and write the outcome audit, all against the SAME `tx`. If anything
  in step (b) throws, the whole transaction rolls back — the dedup claim
  included — so a crash between claiming and finishing the apply looks like
  "never claimed" to the next redelivery: no dropped events, and the network
  call in step (a) never held a transaction open while it ran. A duplicate
  (`recordEventIfNew` -> `false`) writes a `qbo.webhook.duplicate` /
  `outcome: 'skipped'` audit row (so the Integrations activity log can still
  show it happened) and never calls apply. This is tested directly:
  `qbo/inbound-sync.test.ts`'s "claim + apply atomicity" suite drives
  `recordEventIfNew` + `applyInboundEntity` inside one hand-rolled
  transaction, forces a throw *after* a successful apply, and asserts
  `processed_events` has **zero** rows (rolled back) — then asserts a clean
  run leaves exactly one row (committed). Duplicate webhooks are a no-op at
  ingestion — before any apply — satisfying the "duplicate events never
  create duplicate records" requirement.
- **Writes are upserts:** internal writes key on a stable idempotency key (or the
  mapped id) and use `ON CONFLICT`, so a replay updates in place instead of
  inserting. `upsertLink` (`qbo/sync-link-service.ts`, from 20004) is the
  reference implementation for the mapping table; `recordEventIfNew` above
  applies the same `ON CONFLICT DO NOTHING` pattern to event dedup.
- **Outbound safety:** before creating a QBO record the engine checks for an
  existing `SyncLink` / QBO match, so a retried create becomes a no-op or
  update. `outboundIdempotencyKey` (`qbo/idempotency-key.ts`) derives the
  stable key the outbound push (20006) will attach to a QBO write —
  `orgId:entityType:localId:v<localVersion>` — so a retry of the *same*
  local-record version is recognizable as already-attempted, while a write
  for a later version gets a distinct key (a genuinely new push, not a
  retry). Pure derivation only; no network call.
  **Implemented in 20006** as create-vs-update-by-existing-link: `pushEntity`
  (`qbo/outbound-sync.ts`) looks up the `SyncLink` for the local record —
  present with a `qboId` -> sparse `updateEntity` (`Id` + `SyncToken` +
  `sparse: true`); absent -> `createEntity`. A retried push of the same
  document therefore issues an update, never a second create, regardless of
  how many times the route/job re-runs it. The idempotency key itself is
  recorded on the resulting `outbound_sync`/`success` audit row for
  traceability, not sent to Intuit (QBO's own `SyncToken` check is what
  actually prevents a duplicate write; the key exists so a human/operator can
  correlate "which local write produced this QBO record" after the fact).
  When a link exists but its cached `qboSyncToken` is missing (e.g. an
  operator hand-edited the row, or a future task links without one), the
  push refetches the current SyncToken via `getEntity` before updating rather
  than guessing or failing outright.

## Ordering

Events arrive out of order. Each side carries a version / `updatedAt`; the engine
applies a change only if it is newer than what's recorded, and skips (but audits)
stale writes. This makes replay and reordering safe without locking the whole
invoice.

**20008 implements the guard, one-sided (both-sides-changed conflict is the next
section).** The pure comparator lives in `apps/api/src/qbo/ordering.ts`:
`isStaleInboundApply(stored, incoming)`.

- **Primary comparator: QBO `SyncToken`**, a per-entity monotonically increasing
  integer (sent as a string). Apply iff `incoming SyncToken > stored SyncToken`.
  Equal counts as stale — a redelivered/duplicate webhook for the same version is
  an idempotent no-op, not a re-apply.
- **Fallback: `MetaData.LastUpdatedTime` vs the link's recorded `lastSyncedAt`**,
  used whenever a SyncToken is missing or non-numeric on either side (including
  garbage input — the parser never throws, it just falls through to this path).
- **First-ever apply is never stale.** No recorded SyncToken AND no recorded
  `lastSyncedAt` means there's nothing to be older than, so the change always
  applies. This is what lets a brand-new link accept its first sync regardless of
  whatever SyncToken QBO happens to report.
- **Can't-order case defaults to apply, not drop.** If the stored side has a
  timestamp but the incoming side has neither a SyncToken nor a timestamp, the
  guard applies the change rather than silently discarding a real edit — losing
  data is worse than an occasional redundant apply.

Wired into `apps/api/src/qbo/inbound-sync.ts`'s **linked** Invoice/Payment
Update and Void branches only — the unlinked/natural-key-link path has nothing
recorded yet to compare against. A stale inbound change returns
`{action: 'skipped', reason: 'stale_ignored'}` and writes the audit row before any
mutation runs; the link's recorded SyncToken/`lastSyncedAt` are left untouched.

The **same staleness question, mirrored outbound**: `apps/api/src/qbo/outbound-sync.ts`
skips a redundant push (audited `reason: 'already_current'`) when the linked
document's already-pushed `localVersion` is `>=` the local `transactions.version` —
i.e. this exact local version was already sent to QBO, so a repeat push would be a
no-op sparse update. A genuine new local edit (`version` advanced past
`localVersion`) is never skipped. Create and void pushes are unaffected — the
guard only short-circuits the update path.

A carried-forward correctness fix from 20007's review: when an unlinked invoice
is matched by natural key and its metadata patch is applied in the same pass, the
new `SyncLink` row is written (with the *pre-patch* `transactions.version`)
*before* the patch bumps the row's version by one. Left alone, the link's
recorded version would permanently lag the truly-applied version by one, which
would make the outbound guard above see a stale `localVersion` and re-push a
document that's already current. The link is now re-stamped with the post-patch
version immediately after the patch runs.

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

**20006 implements the void half.** When a locally-voided invoice/payment has
never been pushed to QBO (no `SyncLink` with a `qboId`), voiding it locally
has nothing to undo remotely — `voidDocument` (`qbo/outbound-sync.ts`) skips
with no error and no spurious link row. When it was previously synced, the
push calls the write client's `voidEntity` (`?operation=void`, per Intuit's
API) against the linked record; the link **stays `synced`** afterward (the
QBO record still exists, just zeroed), with the fresh `SyncToken` and the
local `version` at void time recorded. Delete semantics (distinguishing an
inbound QBO delete from a void, and any local delete-vs-void UI) are 20009 —
out of scope here.

## Failure handling

External calls fail, time out, or partially apply.

- **Incomplete payloads (implemented, 20007):** a webhook notification only
  ever carries `{name, id, operation}`, never the full record, so the engine
  always refetches full state via `refetchEntity` before applying — there is
  no code path that persists a partial/notification-derived record. **A
  failed refetch (network error, 404, auth failure, …) must never claim the
  event**: the webhook route writes a `qbo.webhook.refetch_failed` /
  `outcome: 'failure'` audit row and moves on WITHOUT calling
  `recordEventIfNew`, so `processed_events` is untouched and Intuit's
  redelivery re-drives the same notification once the transient condition
  (or a missing QBO connection) clears. This is the one failure mode that
  intentionally happens *before* the claim+apply transaction described in
  Idempotency above, since refetch is a network call and must never run
  inside a DB transaction.
- **Retry with backoff:** transient failures retry with exponential backoff; a
  failed item lands in a retryable state visible in the Integrations log for
  manual retry. Not yet implemented for inbound — 20007 only writes the
  `failure` audit and leaves the event unclaimed (relying on Intuit's own
  webhook redelivery); a dedicated retry/backoff loop over failed items is
  20011.
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
