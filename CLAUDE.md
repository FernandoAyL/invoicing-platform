# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

A web platform where a business creates and sends customer invoices, records payments, and keeps **QuickBooks Online (QBO)** as its accounting system of record — bidirectionally and automatically, without double entry or silent data loss when both sides are edited. The service ingests change events from either side (invoice create/update/delete/void, payment status changes) and applies them safely to the other, given that:

- events may be duplicated, delayed, or arrive out of order
- webhook payloads may be incomplete, requiring a refetch of full state
- external API calls can fail or time out
- users can make manual, conflicting edits in both systems concurrently

Five requirements the design must always satisfy — **treat these as invariants when changing sync code:**

1. **Mapping** — a clear correspondence between local invoices/payments/accounts and their QBO counterparts (the `sync_links` table).
2. **Idempotency** — duplicate events or retries must never create duplicate records or repeated writes (`processed_events`, idempotency keys).
3. **Conflict handling** — an explicit strategy for edits made to the same entity in both systems (`sync_links.state = 'conflict'`).
4. **Auditability** — enough persisted history to explain what changed, what action was taken, and whether it succeeded (`sync_audit_logs`).
5. **Failure handling** — retries, backoff, and safe recovery from partial success (the `failed` link state + outbound retry sweep).

Edge cases the sync logic handles: duplicate webhook delivery, out-of-order events, the same invoice edited on both sides, delete-vs-void semantics, partially-paid invoices being edited, timeout after an external write, retry after partial success, and pre-existing invoices on both sides with no prior linkage.

**The design rationale is documented — read it before non-trivial changes:** `docs/PRD.md` (product requirements + data model), `docs/design-decisions.md` (the "why" behind the domain model and sync engine), `docs/architecture-decisions.md` (stack/platform tradeoffs), `docs/design-system.md` (the "Clearbook" visual system for `apps/web`).

## Monorepo layout

pnpm workspaces (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). `packages/*` exists but is currently empty — all code lives in two apps:

| Path | Package | What it is |
|---|---|---|
| `apps/api` | `@invoicing/api` | **Fastify backend + sync engine.** Postgres system of record, QBO integration, session auth. |
| `apps/web` | `@invoicing/web` | **React SPA + marketing site.** Vite, React Router, SSR/prerender for public pages. |
| `docs/` | — | PRD, architecture/design/design-system decisions, and the `backlog/` task pipeline. |
| `.claude/agents/` | — | The planner-orchestrated dev→QA→review agent pipeline (see below). |

## Tech stack

- **Runtime:** Node.js **≥ 24.12**, ESM (`"type": "module"`) everywhere. Package manager **pnpm 9.15.0** (via corepack).
- **⚠️ TypeScript runs directly via Node's type-stripping — there is NO build step for the API.** `node src/index.ts` strips types and runs. This means **you cannot use TS syntax that isn't erasable**: no `enum`, no `namespace`, no experimental decorators, no constructor parameter properties, no `import =`. Use `const` objects + union types instead of enums, and always write **explicit `.ts` extensions on relative imports** (`import { config } from './config.ts'`). CI has an "app boot smoke" step specifically to catch non-strippable syntax.
- **API:** Fastify 5 (plugin architecture via `fastify-plugin`), Drizzle ORM 0.45 over `pg` (node-postgres). Migrations via `drizzle-kit`.
- **Web:** React 19, Vite 8, React Router 7, IBM Plex fonts. SSR entry + static prerender for marketing pages.
- **Tests:** Vitest across both apps. API integration tests use `@electric-sql/pglite` (in-memory Postgres, WASM) — the same migrations that ship to prod are applied, so schema parity holds. Web tests use jsdom + Testing Library.
- **Lint/format:** Biome 2.5.2 (`biome.json`), single tool for both.
- **Infra:** Docker multi-stage build; `docker-compose` for local (Postgres 17 + api + web). Target deploy is **Google Cloud Run** (API) + **Cloud SQL** (Postgres) + **Artifact Registry** + **Secret Manager** + **Cloud Scheduler** (retry sweep) + **Firebase Hosting** (web), all behind Terraform IaC (`infra/terraform`, with an `infra/bootstrap` stack for the Workload Identity Federation CI identity). CD in `deploy.yml`. Kept under ~$30/mo (est. ~$10–13, mostly Cloud SQL).

## Commands

Run from the repo root unless noted. All use pnpm workspace filters.

| Command | Does |
|---|---|
| `docker compose up` | Full local stack: Postgres (`:5432`), api (`:8080`), web (`:5173`). |
| `pnpm dev` | API only, watch mode (`@invoicing/api`, needs a `DATABASE_URL`). |
| `pnpm dev:web` | Web dev server only (Vite, proxies `/api` → `API_PROXY_TARGET` or `localhost:8080`). |
| `pnpm test` | All tests (`pnpm -r test` → vitest in each app). |
| `pnpm typecheck` | `tsc --noEmit` in every workspace. |
| `pnpm check` | Biome lint+format with `--write`. `pnpm lint` / `pnpm format` for single-purpose; `pnpm ci` for the read-only CI check. |
| `pnpm --filter @invoicing/api db:generate` | Generate a Drizzle migration into `apps/api/drizzle/` after editing `db/schema.ts`. |
| `pnpm --filter @invoicing/api db:migrate` | Apply migrations to `DATABASE_URL`. |
| `pnpm --filter @invoicing/api db:seed` | Seed dev org + users (`admin@invoicing.test` / `member@invoicing.test`, password from `SEED_*_PASSWORD`, default `password123`). |

**Env:** copy `.env.example` → `.env`. The API validates config at boot in `apps/api/src/config.ts` (`DATABASE_URL` + `SESSION_SECRET` are required; missing → hard crash). QBO vars are **optional** — leaving `QUICKBOOKS_CLIENT_ID/SECRET/REDIRECT_URI` unset makes `config.qbo` null and the QBO routes fail closed with `503 qbo_not_configured` rather than crashing.

## API architecture (`apps/api`)

- **`buildApp(opts)` in `src/app.ts` is the composition root and the test seam.** It registers plugins then routes and returns the Fastify instance **without listening or starting any timers**. Tests call `buildApp({ db, qboOAuthClient, qboApiClient, ... })` with injected fakes. **`src/index.ts` is the only place that `listen()`s, starts the retry-sweep `setInterval`, and wires graceful shutdown** — keep side-effecting startup out of `app.ts`.
- **Plugins** (`src/plugins/`, decorate the instance): `db` (→ `app.db` Drizzle handle + pool), `auth` (session-cookie verification; decorates `request.user` and exposes the `app.authenticate` preHandler + `app.requireRole(role)` guard), `qbo` (→ `app.qboOAuthClient` / `app.qboApiClient`, built from `config.qbo` or the injected test doubles).
- **Multi-tenant: every domain row is scoped by `orgId`.** Every query must filter by the authenticated user's org — never read/write across orgs. Auth resolves `{ userId, orgId, role }` from the session.
- **Domain model is a unified ledger** (`src/db/schema.ts`): one `transactions` table for all document types (`customer_invoice`, `payment`, `credit_memo`, …) via a `type` enum, with `transaction_lines`, double-entry `ledger_entries` (debit/credit), and `payment_applications` (payment↔invoice N:N). Money is `numeric(14,2)` — Postgres returns it as **strings**; use the `src/money.ts` helpers, never raw JS float math. Deletes are **soft** (`transactions.deletedAt`) to preserve the reconciliation/idempotency trail (delete-vs-void, see the schema comment + design-decisions).
- **Sync engine (`src/qbo/`):** the heart of the service. Notable modules — `sync-link-service` (the mapping), `event-dedup` + `processed_events` (idempotency at ingest), `idempotency-key` / `natural-key` (write idempotency), `ordering` (out-of-order guard), `inbound-sync` / `outbound-sync` (the two directions), `refetch` (fill incomplete webhook payloads), `conflict` (both-sides-changed detection/resolution), `retry` + `retry-sweep` (backoff + the background `runOutboundRetrySweep`), `oauth-client` / `oauth-state` / `connection-service` (QBO OAuth), `webhook-signature` (verify the `intuit-signature` header), `api-client`. When touching any of these, re-check the five invariants above.
- **Routes (`src/routes/`, served under `/api/*`):** `health`, `auth`, `contacts`, `accounts`, `invoices`, `payments`, `integrations` (QBO connect/callback), `qbo-webhook`, `conflicts`, `sync-failures`, `sync-activity`. Fastify JSON-schema validation is on with `removeAdditional: false`, so `additionalProperties: false` in a route schema really 400s.

## Web app (`apps/web`)

- React 19 + Vite + React Router 7. `App.tsx` holds the route table; app routes live in `src/routes/` (Dashboard, Invoices, InvoiceDetail/New/Edit, Customers, Products, Integrations, Conflicts, Login), marketing routes (Home, Pricing, Products) are **SSR-prerendered** via `entry-server.tsx` + `scripts/prerender.mjs` at build time.
- **Same-origin cookie auth:** the app calls `/api/*` with `credentials: 'include'`; the Vite dev server (and docker `web` service) proxy `/api` to the backend so the browser never touches the httpOnly session cookie. `src/lib/RequireAuth.tsx` guards authed routes; `src/lib/api.ts` is the fetch layer.
- **Design:** the "Clearbook" system in `docs/design-system.md` — shared primitives in `src/components/ui/`, app chrome in `src/components/shell/`. Follow it rather than inventing styles.

## Testing conventions

- Tests are **co-located** as `*.test.ts` / `*.test.tsx` next to the code.
- API: prefer the pglite-backed `createTestDb()` helper (`src/__tests__/helpers/`) and the fake QBO clients over mocking Drizzle. Pure logic (money, ordering, backoff, natural-key, conflict) has fast unit tests — extend those rather than reaching for an integration test.
- **Before a PR, all of these must be green** (they are the CI gates): `pnpm ci` (Biome), `pnpm -r typecheck`, the API app-boot smoke import, `docker build`, and both apps' vitest suites.

## CI / CD

- **`.github/workflows/ci.yml`** runs on every push/PR: Biome check → typecheck → app-boot smoke (the type-strippability guard) → `docker build` → api+web vitest with a published JUnit report.
- **`.github/workflows/deploy.yml`** runs on merge to `main`: authenticate to GCP via Workload Identity Federation → build + push the image to Artifact Registry → run migrations as a Cloud Run **Job** (a `--wait` gate; non-zero exit aborts the deploy) → roll the Cloud Run service → publish the web bundle to Firebase Hosting. The IaC layer owns all standing infra; this workflow only calls Artifact Registry / Cloud Run / Firebase Hosting, never provisions. See `docs/design-decisions.md#deploy-and-iac-boundary`.

## Working in this repo (agent pipeline)

Work is tracked in `docs/backlog/` as a four-lane pipeline, driven by the agents in `.claude/agents/` and orchestrated by the **planner** (shared runtime state in `.claude/agents/state.json`, which is gitignored):

```
TODO ──► TOTEST ──► TOCODEREVIEW ──► DONE
 ▲          │             │
 └──────────┴─────────────┘   (QA / review reject → back to TODO with findings)
```

- Tasks carry a phase-prefixed ID (`0000x`/`1000x`/`2000x`/`3000x`) and keep it as they move lanes.
- **developer** implements one task and moves it `TODO → TOTEST`; **qa** verifies end-to-end; **code-reviewer** signs off; the **planner** owns every queue transition except the developer's first move, and never edits product code itself.
- When picking up a task: read the matching requirement in `docs/PRD.md`, the relevant `docs/*-decisions.md` for conventions, implement, and keep the five sync invariants intact.

## Gotchas & conventions

- **Explicit `.ts` import extensions** on every relative import, and **no non-erasable TS syntax** (see Tech stack). This is the most common way to break the build.
- **Never do cross-org reads/writes** — filter every query by `orgId`.
- **Money is `numeric` → string.** Use `src/money.ts`; don't `Number()`-then-arithmetic without rounding through the helpers.
- **Schema changes = `db:generate` a migration** (never hand-write SQL) and update the data-model section of `docs/PRD.md` if the shape changes.
- **QBO is optional infra.** New QBO-dependent routes must fail closed (`503`) when `config.qbo` is null, matching `integrations.ts` / `qbo-webhook.ts`.
- **Don't start timers or listen in `app.ts`** — only `index.ts` does. Tests must never spawn a stray interval.
- `CLAUDE.local.md`, `init.md`, `.env`, `apps/web/dist*`, and the agent runtime state are gitignored — don't commit them.
</content>
</invoke>
