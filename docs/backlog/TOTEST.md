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

_(empty)_

## Phase 2 — Sync engine + CD

- ☐ `20013` Sync engine tests: duplicate webhook, out-of-order, edited-in-both, delete-vs-void, partially-paid edit, timeout-after-write, retry-after-partial-success, pre-existing unlinked invoices
  - **Done:** `apps/api/src/__tests__/sync-engine.e2e.test.ts` (11 `it()`s, real pglite + injectable fake QBO clients, driven through `app.inject`/the real webhook route/`runOutboundRetrySweep` — no production file touched). Coverage: (1) duplicate webhook — redelivery is a byte-identical no-op, one `processed_events` row, one `qbo.webhook.duplicate` audit; (2) out-of-order — a stale SyncToken is skipped without downgrading the stored token, a genuinely newer one still applies; (3) edited in both — a local edit (QBO disconnected) + a genuinely newer inbound update raises `conflict`, applies neither side, and blocks the next outbound push with zero QBO calls; (4) delete vs void — inbound Void zeroes the ledger + flips `status`, inbound Delete soft-deletes without touching `status`, and a later inbound event on the deleted row never resurrects it; (5) partially-paid invoice — a local edit 409s, and (per `docs/design-decisions.md` ## Conflict resolution) a genuinely-newer inbound update after a payment is correctly `conflict`-blocked rather than applied, since `recordPayment` bumps `transactions.version` without resyncing the invoice's own `sync_links.localVersion` — flagged as a plan-vs-actual-behavior mismatch, not an engine bug; (6) timeout after a write — a `failed`/`qboId=null` link coexists with an already-landed QBO entity; (7) retry after partial success — the sweep reconciles via a natural-key query with no second create, plus a plain transient-failure-then-recovery case with exactly one successful create; (8) pre-existing unlinked invoices — a confident natural-key match links without duplicating, an ambiguous match (2 candidates) skips with no mutation; plus one coverage-gap interplay case (a stale event redelivered identically is deduped, not re-skipped). **Attempt 2:** code-review flagged that scenario 5(b)'s `it()` title contradicted its own (correct) assertions — renamed the title only (`sync-engine.e2e.test.ts:698`), no body/assertion change. All gates green: `pnpm -r typecheck` 0, `pnpm -r test` 476 api (465→476, +11) + 71 web (stable serialized), `biome ci .` clean, `docker build` clean, boot smoke `boot import ok`, web build exactly 3 prerendered pages.
