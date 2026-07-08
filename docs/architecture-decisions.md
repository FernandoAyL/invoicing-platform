# Architecture decisions

*Platform and stack tradeoffs — runtime, framework, database engine, deployment, and tooling. Domain and sync-engine design is in [design-decisions.md](./design-decisions.md); product requirements in [PRD.md](./PRD.md).*

Node.js on Google Cloud is the preferred foundation for this project.

## Core infrastructure

- **Postgres (Cloud SQL for PostgreSQL)** — relational integrity and transactions for sync state, ledger entries, and idempotency keys; managed backups/patching without operational overhead. A `db-f1-micro` instance is the single largest line on the bill and, deliberately, the *only* material cost.
- **Cloud Run** — fully-managed serverless containers: an image in, an autoscaled service behind a stable HTTPS URL out. No cluster, no nodes, no load balancer, and no host patching — the managed-container spirit of Fargate, with a stable public URL included for free (which removes an entire class of DNS plumbing; see *Frontend deployment* below).
- **Cloud Scheduler** — drives the outbound retry sweep on a fixed cadence by calling an authenticated internal endpoint, so the container itself can scale to zero between webhooks (see *Why Cloud Run, and how the retry sweep survives scale-to-zero*).
- **Artifact Registry / Secret Manager / Cloud Logging** — the container image registry, the store for `DATABASE_URL` / `SESSION_SECRET` / the sweep token / QBO secrets, and request+app logs, respectively. Each sits inside its free tier for this workload.
- **Terraform** — infra as code for Cloud SQL, the Cloud Run service + migration job, Artifact Registry, Secret Manager, Cloud Scheduler, IAM, and the CI identity (Workload Identity Federation).
- **Docker** — local dev mirrors the production container and is the deployable unit for Cloud Run.
- **No Kubernetes (GKE)** — a control-plane charge (~$72/mo before a single pod) is overhead this one-service workload doesn't need; Cloud Run gives request-level autoscaling directly. This is the same reasoning that ruled out a Kubernetes control plane on AWS, ported to GCP.

## Why Cloud Run, and how the retry sweep survives scale-to-zero

The sync service is a long-running *consumer*: it holds pooled Postgres connections, processes webhook and retry traffic, and serializes/locks around conflicting edits. That shaped the compute choice on both clouds — the correctness of the sync engine depends on connection pooling, ordered processing, and idempotent retries, not on any particular hosting model.

Cloud Run is a managed-container platform (the Fargate analog), not a function-per-request edge runtime, so the pooled-connection, per-request processing model ports directly. The one wrinkle: Cloud Run only allocates CPU **during a request** by default, so an in-process `setInterval` — how the outbound retry sweep runs locally — won't fire reliably between requests. Keeping the timer in-process would require `--no-cpu-throttling` **and** `min-instances=1` (an always-warm instance), which costs roughly $45/mo for the container alone and busts the cost ceiling.

Rather than pay to keep a whole container awake just to fire a timer, the sweep is **externalized to Cloud Scheduler**: one scheduled job (free — three jobs per billing account are free, billed per-job not per-execution) issues an authenticated `POST /internal/retry-sweep`, which runs exactly one `runOutboundRetrySweep` pass. The container is then free to scale to zero between events; a webhook, an API call, or the scheduled sweep spins it up on demand. The endpoint is gated by a shared-secret header (`SYNC_SWEEP_TOKEN`, from Secret Manager) and is safe to invoke repeatedly — the sweep leans on the same idempotency/natural-key guarantees every other outbound write does, so an overlapping or duplicated tick can never double-write. The in-process timer (`index.ts`) is retained for local/compose runs and simply switched off in the deployed environment via `SYNC_RETRY_ENABLED=false`.

*Tradeoff, accepted for the demo:* a cold start adds latency to the first request after an idle period, and QBO webhook delivery tolerates that. If sustained low-latency mattered, `min-instances=1` (CPU-throttled — cheaper than always-allocated) would keep one instance warm without reintroducing the timer.

## Node.js runtime & package manager

Node.js 24 (Active LTS, "Krypton"), not the newer Node 26 Current line — LTS is the right target for a production service.

TypeScript runs directly via native type-stripping (`--experimental-strip-types`, stable since 24.12.0), so no bundler/transpiler sits in the loop for local dev or the container entrypoint. This only strips types rather than checking them, so `tsc --noEmit` runs separately in CI, and codegen-dependent constructs (enums, parameter properties) are avoided.

Package manager is **pnpm**: its content-addressable store and strict `node_modules` resolution catch phantom dependencies early, which matters when idempotent, exact-once writes are the core correctness requirement. It's Corepack-native (pinned via `packageManager` in `package.json`) and `pnpm fetch` lets the Dockerfile install from the lockfile in a cacheable layer before source is copied. Bun was considered and rejected — faster, but no Corepack support and a less proven Fargate deployment story.

## Web framework & Postgres layer

**Fastify** — built-in JSON schema validation is a direct fit for validating inbound webhook payloads, which may arrive incomplete, before they reach sync logic. It also has mature plugins for Postgres pooling, structured logging (pino), and request lifecycle hooks used for audit logging every sync action.

**Drizzle** over Prisma — SQL-first, so queries read like the SQL they generate. That matters when idempotent upserts, `ON CONFLICT` handling, and explicit transaction boundaries are core to the design rather than incidental. `drizzle-kit` gives reviewable migrations for the invoice/payment/link-table schema and sync/audit log.

## Testing

**Vitest** over the built-in `node:test` runner: watch mode, and easy time/date and HTTP mocking for simulating QuickBooks API failures, are worth the one extra dependency given the volume of edge-case tests (duplicate webhooks, out-of-order events, partial-failure retries) this project needs.

**Two-tier test story.** Most unit tests mock the DB with a small hand-rolled fake (`insert().values()` pushing plain JS objects into an array) — fast, and fine for pure logic. But a fake has no column types, constraints, or transactions, so it can't catch a bug where the code writes the wrong *kind* of value into a real column. `20002` shipped two such bugs past the full green suite: a boot-time crash (a TypeScript parameter-property, which Vitest's esbuild transform silently strips instead of rejecting, unlike Node's `--experimental-strip-types`) and a webhook handler writing a non-uuid QuickBooks entity id into a `uuid` column. Both were only caught by a human running the app against live Postgres.

`20015` closed that gap with two additions, not a rewrite of the existing fake-db suite:

- **`createTestDb()`** (`apps/api/src/__tests__/helpers/test-db.ts`) boots an in-memory, in-process real Postgres via `@electric-sql/pglite` + `drizzle-orm/pglite`, and applies the exact migration files shipped to prod (`apps/api/drizzle/*.sql`) — so the test schema is never hand-maintained and always matches prod's types/constraints/FKs. It's opt-in per test file, not a global setup, so the fast pure-logic tests stay fast. Two existing tests (`audit/service.test.ts`, and the DB-touching cases of `routes/qbo-webhook.test.ts`) were ported to it as proof; the rest of the fake-db suite is untouched. New Phase-2 sync tasks that write typed rows (`SyncLink`, `Transaction`, ledger, audit) should use `createTestDb()` from the start.
- **A CI app-boot smoke** (`.github/workflows/ci.yml`, `verify` job) dynamically imports `apps/api/src/app.ts` under real `node` (not Vitest, whose esbuild transform is exactly what let the parameter-property crash through). A load-time `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` or any other import-time error now fails CI directly, without needing a DB connection (the `pg.Pool` connects lazily).

## Frontend deployment

One React/Vite app, one build, covering two kinds of routes:

- **Public routes** (`/`, `/products`, `/pricing`) — prerendered to static HTML at build time (SSG), so they're crawlable and fast.
- **Authenticated routes** (`/login`, `/dashboard`, `/invoices`, ...) — client-rendered, since they're behind login and never crawled.

No SSR server or edge compute either way — the split is a per-route build setting, not two separate projects. All output is static files, served from **Firebase Hosting** (a global CDN, HTTPS, and a generous free tier).

**Same origin, no CORS, plain httpOnly cookie — for free.** Firebase Hosting serves the static build at its own domain and rewrites `/api/**` to the Cloud Run service *under that same hostname* (`rewrites: [{ source: "/api/**", run: { serviceId, region } }]`). The browser sees a single origin, so the session cookie the API sets is same-origin exactly as it is in local dev — the whole point of the cookie-auth design — with a SPA fallback (`** → /index.html`) for client-rendered routes. This is the direct equivalent of the S3 + CloudFront (`/api/*` → backend) pattern, but the managed HTTPS URL Cloud Run already provides means there is **no load balancer, no DNS re-point automation, and no per-IP plumbing** — the previous AWS design needed a Route53 record kept in sync with the task's public IP by an EventBridge → Lambda rule purely to avoid paying for an ALB; on Cloud Run that entire mechanism disappears, because the service URL is stable.

**IaC boundary for Hosting.** Terraform provisions the Firebase *site* (`google_firebase_hosting_site`); the content *release* is `firebase deploy --only hosting` in CD, reading a committed `firebase.json`. That mirrors the same split used everywhere else here — Terraform owns standing infrastructure, CD owns releases (the container image, and now the web bundle) — see [design-decisions.md](./design-decisions.md#deploy-and-iac-boundary).

Downsides, accepted for the demo: Firebase Hosting's `/api/**` rewrite adds a small proxy hop in front of Cloud Run, and a scaled-to-zero service means the first request after idle pays a cold start. Both are acceptable for a single-operator demo, and neither costs anything.
