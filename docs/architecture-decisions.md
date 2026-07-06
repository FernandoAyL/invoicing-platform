# Architecture decisions

*Platform and stack tradeoffs — runtime, framework, database engine, deployment, and tooling. Domain and sync-engine design is in [design-decisions.md](./design-decisions.md); product requirements in [PRD.md](./PRD.md).*

Node.js on AWS is the preferred foundation for this project.

## Core infrastructure

- **Postgres (AWS RDS)** — relational integrity and transactions for sync state, ledger entries, and idempotency keys; managed backups/failover without operational overhead.
- **AWS Fargate** — containers without managing EC2 hosts or a Kubernetes control plane.
- **Terraform** — infra as code for RDS, ECS/Fargate services, networking, and IAM.
- **Docker** — local dev mirrors the production container and is the deployable unit for Fargate.
- **No Kubernetes** — Fargate + ECS gives task-level scaling and service discovery directly; a control plane is overhead this service count doesn't need.

## Why not an edge/serverless architecture

The sync service is a long-running consumer: it holds pooled Postgres connections, processes webhook and retry traffic continuously, and needs to serialize/lock around conflicting edits. Lambda and edge runtimes are built for short-lived, stateless request/response work — cold starts, per-invocation connection setup, and the lack of a persistent process work against exactly the parts of this design (connection pooling, in-process retry/backoff, ordered processing) that matter most. A long-lived container on Fargate avoids all of that, at the cost of paying for idle capacity, which is acceptable here.

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

No SSR server or edge compute either way — the split is a per-route build setting, not two separate projects. All output is static files in one S3 bucket, served from one CloudFront distribution (`/api/*` → backend).

**Suggested, not used: S3 + CloudFront (default origin) and CloudFront → ALB → Fargate (`/api/*` origin).** Single domain, no CORS, plain httpOnly session cookie. Not used because it requires running and paying for an ALB.

**Chosen: skip the routing layer.** The Fargate task gets a public IP directly; a Route53 record points at it; CloudFront's `/api/*` origin points at that Route53 name. An EventBridge rule on ECS task-state-change events triggers a small Lambda that updates the Route53 record whenever the task's IP changes (restart, deploy). No ALB, NLB, API Gateway, or VPC Link anywhere in the path — the only cost beyond the Fargate task itself is fractions of a cent for Route53. This is chosen purely to keep the demo deployment free of fixed infrastructure costs.

Downsides, accepted for the demo: no health checks or connection draining, so a crashed task fails requests until the Lambda re-points DNS; no clean way to run or load-balance across multiple tasks (one task = one IP); and deploys/restarts cause a short window of failed or dropped requests while DNS catches up, instead of the zero-downtime rolling replacement a load balancer gives for free. 
