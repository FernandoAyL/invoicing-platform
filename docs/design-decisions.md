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
credential injected from Secret Manager and never touches this table.
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
  calls `markSynced` with the refetched `SyncToken`; `Void` voids the local
  record; `Delete` soft-deletes it (distinct branches since 20009 — see
  ## Delete vs void below for the full split). An inbound update on an
  already-locally-voided record is a no-op skip — it never un-voids (real
  conflict handling, i.e. flagging that both sides changed, is 20010). Once a
  record is locally soft-deleted, ANY further inbound operation on it
  (Update/Void/a redelivered Delete) is likewise a no-op skip — deletion is
  terminal.
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
  `synced`) and then applies the same metadata patch as the linked path; an
  `ambiguous` result writes a `qbo.inbound.skip` audit and creates no link —
  never auto-created, never guessed, surfaced for a human (20012). A `none`
  result — no existing local Invoice matches — is **imported** (30016; see
  "Inbound create" below) rather than deferred. `Void`/`Delete` of an
  unlinked entity is a skip — there's no local record to void. No
  natural-key matcher exists for Payment (20004 only built Contact/Invoice
  matchers), so there's no "link the existing pair" step to try for an
  unlinked Payment — a `Create`/`Update` goes straight to import (see
  "Inbound create" below); `Void`/`Delete` is still a skip (nothing local to
  act on).
- **Customer is linking-only.** A linked Customer `Update` only refreshes the
  link's `SyncToken` — the Contact row's own fields (`displayName`, `email`,
  …) are never patched from QBO in this task, matching the "keep apply to
  Invoice + Payment (+ Customer linking)" scope. A Customer `Void`/`Delete`
  has no local equivalent (a Contact has no void state) and is a documented
  skip either way.
- **Content-update depth.** A linked Invoice `Update` patches
  `DocNumber`/`TxnDate`/`DueDate`/`PrivateNote` metadata, and — since
  **30015** — also re-syncs the invoice's **lines + total** when the
  refetched body carries a `Line[]`: each `SalesItemLineDetail` line maps to
  a local line (`ItemRef` resolved to a local item via `sync_links`, falling
  back to the org's default sales-income account when the item is unmapped),
  `transaction_lines` is delete+reinserted, and the ledger is re-posted
  atomically — `zeroOutLedger` then `postLedger`, reusing the same
  `buildInvoicePostings` local create/edit already uses — **in the same tx**
  as the metadata patch, so the local ledger is never left half-applied
  between the two. A QBO body with no `Line[]` at all (e.g. a sparse
  metadata-only webhook payload) still takes the metadata-only path
  unchanged — the mapper (`qboInvoiceToLocalLines`) returns `undefined`
  rather than an empty set, so "QBO didn't say" is never confused with "QBO
  said zero lines". **Guard:** if the new total would drop below the
  invoice's already-applied paid amount, nothing is mutated — the link is
  flagged `conflict` instead (`wouldUnderflowPaidAmount`, see
  ## Conflict resolution below) rather than silently stranding a payment
  above the new total or driving A/R negative. This closes what had been a
  documented, conservative-by-construction boundary (amounts were simply
  never touched by the inbound Update path); **live-verified post-deploy**
  against the QBO sandbox — a QuickBooks-side invoice amount edit now
  correctly reaches the local ledger, balanced, matching the equivalent
  metadata-only (e.g. due-date) edit that already synced. A linked Payment
  `Update` is still metadata-only (`TxnDate`/`PrivateNote`) — a Payment's
  *amount* effect on its invoice is only ever changed via the `Void`/`Delete`
  path, which removes the `payment_applications` row, zeroes the payment's
  ledger postings, and recomputes the invoice's `status`/`balance` from its
  remaining applied payments (mirroring `payments/service.ts`'s recompute,
  kept as a small local copy in `inbound-sync.ts` since the inbound context
  has no `PaymentContext`/user actor to reuse the exported route-level
  helpers with).
- **Inbound create.** Materializing a QBO-originated Invoice or Payment as a
  *brand-new* local row is implemented for both, closing what was originally
  a documented "deferred, needs manual linking" boundary.
  - **Invoice (30016):** `createLocalInvoiceFromQbo` resolves/creates the
    local contact from `CustomerRef` (via `sync_links`, or a new `Contact`
    keyed to the QBO customer id when none exists), maps `Line[]` to local
    lines (`mapQboInvoiceLines` — only `SalesItemLineDetail` lines, so the
    mapped set always sums to a balanced ledger), inserts the invoice via the
    same `insertCustomerInvoice` core the local create path uses, and links
    it to the QBO id. A body with no mappable lines skips
    (`inbound_create_no_lines`) rather than creating an unbalanced or
    zero-line invoice.
  - **Payment (30019):** `createLocalPaymentFromQbo` requires **every**
    invoice the payment applies to (via each `Line[]` entry's
    `LinkedTxn: [{TxnType: 'Invoice'}]`) to already be linked locally — an
    inbound payment can only settle a debt this system already knows about,
    never conjure the invoice it's for. Any unresolvable `LinkedTxn` skips
    the **whole** payment (`inbound_payment_unresolved_invoice`), never a
    partial import; a body with no linked-invoice lines at all skips
    (`inbound_payment_no_linked_invoices`). Otherwise: resolves/creates the
    contact the same way the invoice path does (shared
    `resolveOrCreateContactFromRef`), inserts one `payment` transaction, one
    `payment_applications` row per resolved line, a single aggregate
    debit-deposit / credit-A/R ledger posting for the total (mirroring
    `payments/service.ts`'s `recordPayment`), and recomputes every affected
    invoice's `status`/`balance` via the existing
    `recomputeLocalInvoiceBalance`.
  - Both are idempotent the same way every other inbound apply is:
    event-dedup catches byte-identical redelivery, a later distinct event
    for the same QBO id finds the link just created and takes the normal
    linked-update path, and the `(orgId, qboType, qboId)` unique on
    `sync_links` rolls back a racing double-create so the event is
    re-driven, never duplicated.
  - **Still out of scope:** an inbound Customer `Create` with no
    natural-key match (Customer stays linking-only — see above; a Payment's
    `CustomerRef` can still create a Contact as a *side effect* of importing
    an Invoice/Payment, just never as its own top-level inbound-create
    operation).

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

The PRD states the policy (flag, don't guess); **20010 implements the mechanism.**
On each inbound apply, the engine compares the last-synced version on both sides.
If **both** changed since the last successful sync, it does not merge or pick a
winner automatically — it marks the link `conflict`, stops writing that record in
either direction, and requires a user to choose the winning version via
`GET /api/conflicts` + `POST /api/conflicts/:linkId/resolve`. **Last-write-wins was
rejected**: it silently loses one side's edits, which for financial records is
worse than a visible stop.

**Detector.** A pure function, `isBothSidesConflict(local, incomingIsStale)` in
`apps/api/src/qbo/conflict.ts`: `true` iff **local is dirty**
(`transactions.version > sync_links.localVersion`, with a `null` `localVersion`
treated as NOT dirty so a link that has never recorded a version never
false-flags) **and** the incoming QBO change is genuinely newer
(`isStaleInboundApply` — see ## Ordering above — returned `false` for this same
event). Because the stale check always runs first and returns early, the
conflict check only ever runs when "incoming is newer" is already established —
the effective condition is local-dirty. `conflictDetectedAt` (a new nullable
`sync_links` column) is stamped when a conflict is raised and cleared the moment
the link returns to `synced`.

**Placement — after stale, before mutate.** `apps/api/src/qbo/inbound-sync.ts`
inserts the check into every linked Invoice/Payment Update/Void/Delete branch,
immediately after that branch's own `isLinkStale` early-return and before any
`markSynced`/mutation. On conflict: `markConflict` (state + timestamp), an audit
row (`qbo.inbound.conflict`), and `{action: 'conflict', reason:
'both_sides_changed'}` — **nothing is applied**, and the stored SyncToken/
localVersion are left at their pre-conflict snapshot so resolution has something
stable to compare against. This is also where the two carried-forward conflict
edges from 20007/20009 (a locally-paid invoice voided/deleted in QBO, editing
metadata over a local edit) get reclassified as conflicts instead of a silent
zero-ledger or 404 — the same both-sides-changed check catches all of them,
because "the local side changed since last sync" is true whether that change was
an edit, a payment, a void, or a delete.

**Stop writing in BOTH directions while conflicted.** Outbound
(`apps/api/src/qbo/outbound-sync.ts`) checks the link's state at the top of
`syncInvoiceOutbound`/`syncPaymentOutbound`: `state === 'conflict'` skips the push
entirely (`reason: 'conflict_blocked'`, zero QBO calls) — a conflicted record's
local edits are never propagated until a human resolves it. Inbound, a repeated
webhook event on an already-`conflict` link is held (re-run the stale check; if
not stale, stay in conflict with a `conflict_held` audit and no mutation) —
idempotent, so redelivery during the window a conflict sits unresolved never
flip-flops the record.

**Resolution picks a winner and re-drives the existing sync paths — never a
merge.** `POST /api/conflicts/:linkId/resolve {winner: 'local' | 'qbo'}`:

- **`winner: 'local'`** force-pushes the current local record through the normal
  outbound push (a new `force` flag on `OutboundParams` bypasses both the
  `conflict_blocked` guard and the `already_current` redundant-write guard), then
  `markSynced` — new QBO SyncToken, `localVersion` at the local `version`,
  `conflictDetectedAt` cleared. If the force-push itself fails (network), the
  link is deliberately left in `conflict` (not `failed` — that would drop it out
  of the conflicts list and into the unrelated 20011 retry queue instead of back
  in front of the user who is actively resolving it), and a
  `conflict.resolve_failed` audit is written. No partial commit either way.
- **`winner: 'qbo'`** refetches the QBO record and applies it locally through the
  exact same `applyInboundEntity` used by the webhook path, with a `bypassConflict`
  flag that skips both the held-gate and the conflict check on this one call.
  Because this route is user-initiated (not a webhook redelivery), it has no
  `operation` (Update/Void/Delete) of its own — it recovers the operation that
  most recently raised or held the conflict from the `qbo.inbound.conflict`/
  `conflict_held` audit trail already written for that link, rather than adding a
  second schema column to carry it. A QBO void/delete winning over a locally-paid
  invoice applies exactly as the existing inbound void/delete path always has —
  zero the ledger / soft-delete, leave `payment_applications` alone. **Full
  payment reversal/credit-memo generation is Phase 4**, out of scope here; this
  is a clean, documented seam, not a silent gap.
- Resolving a link that isn't `conflict` → `409`. Unknown/cross-org `linkId` →
  `404`. Invalid `winner` → `400`.

**Web.** `/conflicts` (`apps/web/src/routes/Conflicts.tsx`) lists every conflict
with the local doc summary and two actions, "Keep mine" / "Use QuickBooks
version", mapping 1:1 to `winner: 'local' | 'qbo'`. A field-by-field local-vs-QBO
diff is optional/nice-to-have — picking a winner is the deliverable. The sidebar
carries a "needs attention" count badge from the same list endpoint.

**A second, distinct conflict kind (30015): paid-amount underflow.**
`isBothSidesConflict` answers "did both sides change since the last sync" — it
says nothing about whether a change is *safe* to apply on its own. The inbound
line/amount re-sync (see ## Mapping above) introduces a case that isn't a
version race at all: QBO's side, taken alone, is perfectly valid (a balanced
edit), and the local side hasn't been touched — but applying QBO's new,
smaller total would leave the invoice owing less than what's already been
recorded as paid. `wouldUnderflowPaidAmount(totalCents, paidCents)`
(`apps/api/src/qbo/conflict.ts`) catches exactly this and routes it through
the same `markConflict` + `conflict` link state + `/conflicts` UI as
`isBothSidesConflict`, rather than reversing/crediting the payment
automatically or silently forcing a negative-implied balance. The two
detectors are independent (different inputs, different questions) but share
one resolution surface: per the design call that as long as each individual
edit is itself internally balanced there's no ledger-integrity risk in just
*surfacing* the both-sides case to a human, rather than over-engineering an
automatic reconciliation for what is, in practice, a rare edit-after-payment
timing issue.

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
local `version` at void time recorded.

**20009 implements the delete half — a new `transactions.deletedAt` column,
not a hard row delete and not a status value.** The alternative — actually
`DELETE`-ing the `transactions` row — was rejected: it would cascade to
`ledger_entries`/`payment_applications`/`sync_links` (FKs `ON DELETE CASCADE`
on the child tables), destroying the reconciliation/idempotency trail, and a
later inbound create/update event for the same `qboId` would find no
`SyncLink` and re-create the record from scratch. A dedicated `status`
enum value was also rejected: `deletedAt` needs to be **orthogonal** to
`status` (a deleted invoice can have been `open` or `void` at the moment of
deletion, and that history is worth keeping distinguishable from "deleted
while paid"), and a nullable timestamp doubles as its own "when" audit trail
for free.

- **What "deleted" means locally.** `deletedAt` set (instead of `status`)
  makes the record invisible to every read path — `getInvoice`/
  `listInvoices`, `getPayment`/`listPaymentsForInvoice` all filter
  `isNull(transactions.deletedAt)`, so a deleted invoice/payment 404s on a
  direct `GET` and never appears in a list or a dashboard aggregate — while
  the row, its `ledger_entries`, and its `sync_links` row are all retained.
  A delete also zeroes the ledger the same way a void does (`zeroOutLedger`)
  — a deleted record has no accounting effect either.
- **Local-initiated delete: guarded by status.** `deleteInvoice`
  (`invoices/service.ts`) allows deleting an `open` or `void` (unpaid)
  invoice, and refuses `partially_paid`/`paid` with `InvalidStateError` —
  mirroring how `voidInvoice` only allows `status === 'open'`. A
  `partially_paid`/`paid` invoice has real payments applied against it;
  unwinding that is a reversal/refund concern, not a delete (out of scope
  here). `deletePayment` has no equivalent status guard — a payment can be
  deleted whether `paid` or already `void` (mirrors "a voided invoice can
  still be deleted" below), reusing `voidPayment`'s mechanics (remove the
  `payment_applications` row, zero the payment's ledger, recompute the
  applied invoice) when there's still an application to reverse, and a
  no-op recompute when there isn't (the payment was already voided, whose
  own application-removal already happened).
- **Inbound delete: not guarded by status.** A QBO `Delete` of a
  locally-**paid** invoice still soft-deletes locally, unconditionally — QBO
  already deleted it, refusing the apply wouldn't undo that fact. The apply
  deliberately leaves `payment_applications` intact (it never touches them
  for an invoice-delete, exactly like invoice-void never does either) — the
  "deleted in both while paid" conflict nuance is 20010's territory; this is
  a clean seam, not a reversal attempt. Inbound Payment `Delete` mirrors
  Payment `Void`'s existing mechanics (remove the application, zero the
  payment's ledger, recompute the invoice), just stamping `deletedAt`
  instead of `status: 'void'`.
- **Outbound: `deleteDocument` mirrors `voidDocument`.** A never-synced local
  delete has nothing remote to delete — skip, no error, no spurious link
  (same shape as void). A previously-synced delete calls the new write
  client method `deleteEntity` (`?operation=delete`, `qbo/api-client.ts`)
  against the linked record and marks the link `synced` (not removed —
  see idempotency below) with the fresh `SyncToken`. The **entry point
  decides void-vs-delete by checking `deletedAt` before `status`** —
  `syncInvoiceOutbound`/`syncPaymentOutbound` check `txn.deletedAt` first,
  so a voided-then-deleted document pushes a delete, not a void (`deletedAt`
  is the more terminal of the two local states). Audited as
  `outbound_delete`, distinct from `outbound_void`.
- **Inbound: split the Delete/Void collapse.** Before 20009,
  `applyInboundEntity` mapped both `Void` and `Delete` to the same local
  void (`VOID_OPERATIONS = {Void, Delete}`). Now `Void` voids and `Delete`
  soft-deletes via distinct branches (`softDeleteLocalInvoiceRow`/the
  Payment-delete branch in `applyLinkedPayment`), audited as
  `qbo.inbound.delete` vs `qbo.inbound.void`. The 20008 stale-SyncToken
  ordering guard applies to the delete branch the same way it already did
  to void — a stale `Delete` is skipped, never clobbering newer state.
  Anywhere the two operations remain equivalent (nothing local to act on
  either way — an unlinked invoice, or any Customer `Void`/`Delete`, since a
  Contact has no void-or-delete state locally) still treats them together
  via `VOID_OR_DELETE_OPERATIONS`.
- **Idempotency and terminality.** Deleting an already-deleted record
  (local or inbound) is a no-op skip (`{action: 'skipped', reason:
  'already_deleted'}`), not a 404 and not an error — so a retried delete
  call, or a redelivered `Delete` webhook, is always safe. Once a record is
  soft-deleted, the link row is **retained, not removed** — this is what
  prevents a later create/update event for the same `qboId` from
  resurrecting a live local record (the outbound side sees the link and
  never re-creates; the inbound side sees the link and treats any further
  operation on it as the same terminal no-op, per the Mapping section
  above).
- **A void can still be deleted; a delete is terminal.** Voiding then
  deleting the same invoice/payment is a normal sequence (removes it from
  view after the fact) — both the local guard and the outbound
  `deletedAt`-before-`status` check allow it. The reverse never happens:
  there is no un-delete, matching "delete then anything is terminal."

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
- **Retry with backoff (implemented, 20011):** a `SyncLink` is the failed-item /
  retry-queue record — including a **first-ever** outbound push failure, which
  previously left no link at all (`markFailed` was UPDATE-only and domain
  create seeded no row, so a brand-new push failure was invisible to any retry
  loop). `sync_links.qboId` is now nullable so a link can model "we intend to
  sync this, no QBO id yet" as well as "already synced". `failOutbound` UPSERTs
  a `failed` link (seeding one with `qboId=null` on a first-ever failure),
  stamping `retryCount += 1`, `lastError`, and `nextRetryAt` via
  `computeBackoff` (`qbo/retry.ts`: exponential, base 30s, capped at 1h,
  terminal — `nextRetryAt=null` — after `MAX_RETRY_ATTEMPTS=8`). `markSynced`
  unconditionally clears all three on a successful (re)push. A `conflict` link
  is never demoted to `failed` by this path — a conflict is a user decision
  (20010), not a transient failure. A background sweep
  (`runOutboundRetrySweep`, `qbo/retry-sweep.ts`) re-drives every `failed` link
  whose backoff has elapsed, cross-org, reusing the existing
  `syncInvoiceOutbound`/`syncPaymentOutbound`/`ensureEntitySynced` machinery
  (never forked); its timer is started exactly once, in `index.ts` only, after
  `listen`, gated by `SYNC_RETRY_ENABLED`/`SYNC_RETRY_INTERVAL_MS`, and
  guarded against overlapping runs — `app.ts` (what every test builds) never
  spawns it. The failed-item queue is exposed via `GET /api/sync/failures`
  (org-scoped: id, retryCount, nextRetryAt, lastError, qboId) and a manual
  retry is `POST /api/sync/failures/:linkId/retry` (forces an immediate
  attempt regardless of backoff; 20012 builds the Integrations-page button
  that calls it). Inbound is unchanged — 20007 still only writes the
  `failure` audit and leaves the event unclaimed, relying on Intuit's own
  webhook redelivery; no persisted inbound retry store was added.
- **Partial success after a write (implemented, 20011):** a write that times out
  may have landed even though the local link write never happened — QBO has no
  request-idempotency key (`idempotency-key.ts` is audit-only), so blindly
  re-issuing a CREATE retry risks duplicating a financial record. Before a
  CREATE retry (a `failed` link with `qboId IS NULL`), the engine reconciles
  first: it queries QBO by natural key (`qbo/natural-key.ts`'s
  `matchInvoiceByNaturalKey`/`matchContactByNaturalKey` over candidates from
  the QBO client's `queryEntities`) and, on a confident single match, links to
  the existing record (`markSynced`-equivalent) instead of creating a second.
  An ambiguous match is never auto-linked — it's surfaced back into the failed
  queue for a human to resolve, same philosophy as the natural-key matchers
  elsewhere. Only a genuine "no match" proceeds to a real create. Update/void/
  delete retries need no such check — they re-issue safely against the
  already-known `qboId` (sparse update with the stored/refetched SyncToken;
  void/delete are idempotent-ish, QBO last-value-wins).

## Auditability

Every mutating and sync action appends to `SyncAuditLog` (entity, action,
direction, outcome, timestamp, triggering event). It is append-only, so the
history explains what changed, what action was taken, and whether it succeeded —
the basis for both the Integrations activity log and debugging a divergence.

## Deploy and IaC boundary

Two ownership lanes, and **no Terraform in the deploy path**:

- **Terraform owns infrastructure** — Cloud SQL, Artifact Registry, the Cloud Run
  service + migration job, Cloud Scheduler, Secret Manager, IAM, and the Firebase
  Hosting site. Run deliberately (locally for this project) on the rare stack change.
- **GitHub Actions owns releases** — on merge to `main`: build the image, push to
  Artifact Registry, run migrations as a Cloud Run **Job**, roll the Cloud Run
  service to the new revision, and publish the web bundle to Firebase Hosting.

Rationale: it keeps CI's blast radius tiny (the pipeline can roll the app but not
create or destroy infrastructure), makes deploys fast (no `terraform apply` per
merge), and matches the "no unnecessary standing infrastructure" stance — Cloud
Run's URL is stable, so unlike the previous AWS design there is no DNS record for
either Terraform or CD to keep in sync with a task's IP.

**Avoiding image drift.** If Terraform managed the Cloud Run service's image, a
CI-driven image change would show as drift and the next `apply` would try to revert
it. So Terraform stands the service (and the migration job) up with a placeholder
`bootstrap_image` but `lifecycle { ignore_changes = [template[0].containers[0].image] }`;
CD owns every revision after that. Clean ownership boundary, no tug-of-war over the tag.
The Firebase site follows the same split — Terraform provisions the *site*, `firebase
deploy` publishes the *content* from a committed `firebase.json`.

**CI identity.** GitHub Actions authenticates to GCP via **Workload Identity
Federation** (no long-lived service-account keys): a GitHub OIDC token is exchanged
for short-lived credentials that impersonate a deployer service account, trust-scoped
to this repo. Its roles are limited to Artifact Registry push, Cloud Run admin +
`iam.serviceAccountUser` (to deploy as the runtime SA), and Firebase Hosting admin —
nothing that can touch Terraform state or provision new infrastructure.

**Migrations** run as a one-off Cloud Run Job on the new image (`gcloud run jobs
execute --wait`) *before* the long-running service is rolled, so a non-zero exit
fails the deploy before traffic reaches new code — the same gate the old AWS
`ecs run-task` migration step provided.

**The retry sweep is not part of deploy.** It runs continuously via a Cloud Scheduler
job hitting an authenticated internal endpoint on the running service, independent of
releases — see [architecture-decisions.md](./architecture-decisions.md#why-cloud-run-and-how-the-retry-sweep-survives-scale-to-zero).

*Not adopted, but noted:* running Terraform in CI (`plan` on PR, `apply` on merge)
buys reviewed/audited infra changes and avoids laptop-state/cred drift — worth it
for a team or multiple environments, overkill for a single-environment solo
deploy. A cheap middle ground is a read-only `terraform plan` on infra PRs while
still applying locally.
