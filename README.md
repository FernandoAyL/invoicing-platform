# Invoicing Platform

Two-way invoice sync service between an internal invoicing system and **QuickBooks Online (QBO)**.

Live at https://clearbooks-501812.web.app

| Email | Password | Role |
|---|---|---|
| `admin@invoicing.test` | `password123` | `admin` |
| `member@invoicing.test` | `password123` | `member` |

The service ingests change events from either side — invoice creation, updates, deletions/voids, payment status changes — and applies them safely to the other system, handling duplicate, delayed, or out-of-order events, incomplete webhook payloads, external API failures, and conflicting manual edits made in both systems concurrently.

Design goals: **mapping**, **idempotency**, **conflict handling**, **auditability**, and **failure handling** (retries, backoff, safe recovery from partial writes). See [`docs/`](docs/) — [`design-write-up.md`](docs/design-write-up.md) for a concise tour of the sync engine and its edge-case coverage, and [`PRD.md`](docs/PRD.md), [`design-decisions.md`](docs/design-decisions.md), and [`architecture-decisions.md`](docs/architecture-decisions.md) for the full rationale.

## Stack

| Layer | Choice |
|---|---|
| API | Fastify 5 on Node 24 (runs TypeScript directly via Node's native type stripping — no build step) |
| Web | React 19 + React Router 7 + Vite (SSR + prerender) |
| Database | PostgreSQL 17 |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Monorepo | pnpm workspaces (`@invoicing/api`, `@invoicing/web`) |
| Lint / format | Biome |
| Tests | Vitest (API uses PGlite for an in-memory Postgres) |

## Repository layout

```
apps/
  api/    @invoicing/api — Fastify server, Drizzle schema/migrations, QBO sync
  web/    @invoicing/web — React SPA/SSR frontend
docs/     design decisions, PRD, architecture notes, backlog
docker-compose.yml   db + app (api) + web for local dev
Dockerfile           multi-stage: `dev` (default) and `runner` (deploy)
```

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose (the recommended path — nothing else needed)
- For running outside Docker: Node.js `>=24.12` and pnpm `9.15.0` (via `corepack enable`)

## Quick start (Docker Compose)

```bash
# 1. Configure environment (compose falls back to the same defaults if .env is absent)
cp .env.example .env

# 2. Build and start db + api + web
docker compose up --build

# 3. In another terminal, run migrations and seed dev users (first run only)
docker compose exec app pnpm --filter @invoicing/api db:migrate
docker compose exec app pnpm --filter @invoicing/api db:seed
```

Services once up:

| Service | URL | Notes |
|---|---|---|
| `web` | http://localhost:5173 | Vite dev server; proxies `/api` → `app:8080` |
| `app` (api) | http://localhost:8080 | Fastify API |
| `db` | localhost:5432 | Postgres 17 (`invoicing`/`invoicing`) |

### Test user credentials

`pnpm --filter @invoicing/api db:seed` creates the **Acme Invoicing** org with two users. Passwords come from the `SEED_ADMIN_PASSWORD` / `SEED_MEMBER_PASSWORD` env vars, defaulting to `password123`.

| Email | Password | Role |
|---|---|---|
| `admin@invoicing.test` | `password123` | `admin` |
| `member@invoicing.test` | `password123` | `member` |

> Dev/sandbox only — the seed is idempotent (`onConflictDoNothing` on email). Change the passwords via the `SEED_*` env vars and never use these accounts in a real environment.

## Common Docker Compose commands

```bash
# Start everything (rebuild images when Dockerfile/deps change)
docker compose up --build

# Start in the background
docker compose up -d

# Follow logs (all services, or one)
docker compose logs -f
docker compose logs -f app

# Stop containers (keep volumes/data)
docker compose down

# Stop and wipe the database volume (fresh start)
docker compose down -v

# Rebuild a single service after dependency changes
docker compose build app

# Restart one service
docker compose restart web

# Open a shell in the api container
docker compose exec app sh

# Run any workspace script inside the container
docker compose exec app pnpm --filter @invoicing/api <script>

# Database: migrate / generate migration / seed
docker compose exec app pnpm --filter @invoicing/api db:migrate
docker compose exec app pnpm --filter @invoicing/api db:generate
docker compose exec app pnpm --filter @invoicing/api db:seed

# psql into the database
docker compose exec db psql -U invoicing -d invoicing
```

## Running without Docker

```bash
corepack enable          # provides pnpm 9.15.0
pnpm install

# Point the api at a running Postgres
export DATABASE_URL=postgres://invoicing:invoicing@localhost:5432/invoicing

pnpm --filter @invoicing/api db:migrate
pnpm --filter @invoicing/api db:seed

pnpm dev            # api (@invoicing/api), watch mode on :8080
pnpm dev:web        # web (@invoicing/web) on :5173
```

## Workspace scripts (root)

| Command | Description |
|---|---|
| `pnpm dev` | Run the API in watch mode |
| `pnpm start` | Run the API (no watch) |
| `pnpm dev:web` | Run the web dev server |
| `pnpm build:web` | Build the web app (SSR + prerender) |
| `pnpm test` | Run all workspace tests (Vitest) |
| `pnpm typecheck` | Type-check every package |
| `pnpm check` | Biome format + lint with `--write` |
| `pnpm lint` | Biome lint |
| `pnpm format` | Biome format with `--write` |
| `pnpm ci` | Biome CI check (no writes) |

## Configuration

All local config lives in `.env` (copy from `.env.example`). Key variables:

| Variable | Purpose | Default |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | Postgres credentials | `invoicing` |
| `DB_PORT` / `APP_PORT` / `WEB_PORT` | Host port mappings | `5432` / `8080` / `5173` |
| `DATABASE_URL` | API connection string (derived by compose; set manually outside compose) | — |
| `SESSION_SECRET` | Signs the session cookie — set a long random value in real envs | `dev-only-change-me` |
| `SESSION_TTL_HOURS` | Session lifetime | `168` (7 days) |
| `SEED_ADMIN_PASSWORD` / `SEED_MEMBER_PASSWORD` | Passwords for seeded dev users | `password123` |
| `QUICKBOOKS_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | Intuit developer app credentials | unset |
| `QUICKBOOKS_ENVIRONMENT` | `sandbox` or `production` | `sandbox` |
| `QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN` | Verifies the `intuit-signature` header on inbound webhooks | unset |

**QuickBooks integration is optional locally.** Leaving any of `CLIENT_ID` / `CLIENT_SECRET` / `REDIRECT_URI` unset disables it (`config.qbo` is `null`); the connect/callback routes return `503 qbo_not_configured` and the webhook route fails closed with `503 qbo_webhook_not_configured` rather than accepting unsigned calls. In deployed environments these secrets are injected from Google Secret Manager, never committed.

## Testing

```bash
pnpm test                              # all packages
pnpm --filter @invoicing/api test      # api only (Vitest + in-memory PGlite)
pnpm --filter @invoicing/web test      # web only
```

## Deployment

The `Dockerfile` is multi-stage. `dev` is the default target (full workspace install + bind-mounted source, used by compose). CD builds the `runner` stage explicitly — `docker build --target runner .` — which installs only the API's production dependencies and runs the TypeScript source directly via `pnpm --filter @invoicing/api start`.

Container-based deployment targets **Google Cloud Run** (managed serverless containers) with Postgres on **Cloud SQL**, the image in **Artifact Registry**, secrets in **Secret Manager**, database migrations run as a one-off **Cloud Run Job**, the outbound retry sweep driven by a **Cloud Scheduler** job, and the web bundle served from **Firebase Hosting** (same-origin `/api/**` rewrite → Cloud Run). CI authenticates via **Workload Identity Federation** — no long-lived keys. All standing infrastructure is Terraform (`infra/terraform`, plus a `infra/bootstrap` stack for the CI identity); GitHub Actions (`.github/workflows/deploy.yml`) owns releases. Estimated run cost is ~$10–13/mo, dominated by Cloud SQL. See [`docs/design-decisions.md`](docs/design-decisions.md) for the deploy / IaC boundary and [`docs/architecture-decisions.md`](docs/architecture-decisions.md) for the platform rationale.

### First-time deploy bootstrap (GCP)

A one-time, hand-run setup for a single operator. Steps 4–5 apply Terraform and need
**project-owner** credentials; Terraform state is local (gitignored). Everything from step 7 on is
automated by CD on merge to `main`. See [`infra/terraform/README.md`](infra/terraform/README.md) and
[`infra/bootstrap/README.md`](infra/bootstrap/README.md) for the per-stack detail.

**1. Install & initialize the gcloud CLI**

```bash
# a. Install — https://cloud.google.com/sdk/docs/install
#    (macOS: `brew install --cask google-cloud-sdk` · Windows: `scoop install gcloud` · Linux: apt/tarball)
# b. Authenticate and pick the account + project
gcloud init
# c. Default region
gcloud config set compute/region us-central1
# d. Default zone
gcloud config set compute/zone us-central1-a
```

**2. Project prerequisites — billing + the two APIs Terraform needs before it can enable the rest**

```bash
PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

# Cloud SQL and Cloud Run require an active billing account — check, and link one if needed:
gcloud billing projects describe "$PROJECT_ID"
# gcloud billing projects link "$PROJECT_ID" --billing-account=XXXXXX-XXXXXX-XXXXXX

gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com
```

**3. Application Default Credentials for Terraform** (separate from the CLI's own login above)

```bash
gcloud auth application-default login
```

**4. Apply the bootstrap stack — Workload Identity Federation + deployer service account** (from the repo root, as a project owner)

```bash
terraform -chdir=infra/bootstrap init
terraform -chdir=infra/bootstrap apply -var project_id="$PROJECT_ID" -var project_number="$PROJECT_NUMBER"
```

**5. Apply the main infrastructure stack** — Cloud SQL, Artifact Registry, the Cloud Run service + migration job (on a placeholder image until the first deploy), Cloud Scheduler, Secret Manager (DB URL / session secret / sweep token), the Firebase Hosting site, and IAM

```bash
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform apply -var project_id="$PROJECT_ID"
```

**6. Wire the GitHub Actions repo variables** consumed by `.github/workflows/deploy.yml`, straight from the Terraform outputs

```bash
gh variable set GCP_REGION            --body us-central1
gh variable set GCP_PROJECT_ID        --body "$PROJECT_ID"
gh variable set AR_REPOSITORY         --body "$(terraform -chdir=infra/terraform output -raw artifact_registry_repository)"
gh variable set CLOUD_RUN_SERVICE     --body "$(terraform -chdir=infra/terraform output -raw cloud_run_service_name)"
gh variable set CLOUD_RUN_MIGRATE_JOB --body "$(terraform -chdir=infra/terraform output -raw cloud_run_migrate_job_name)"
gh variable set WIF_PROVIDER          --body "$(terraform -chdir=infra/bootstrap output -raw workload_identity_provider)"
gh variable set DEPLOYER_SA           --body "$(terraform -chdir=infra/bootstrap output -raw deployer_service_account_email)"
```

**7. First deploy** — push/merge to `main` or trigger the workflow; CD builds the image → Artifact Registry, gates on the migration Cloud Run Job, rolls the Cloud Run service, and publishes the web bundle to Firebase Hosting

```bash
gh workflow run deploy.yml --ref main
```

**8. (Optional) Seed demo data** — the deploy runs *migrations* but not *seed*, so the production database starts with no users. To create the same demo data as local (`Acme Invoicing` org + `admin@invoicing.test` / `member@invoicing.test`, password `password123`), run the manually-triggered seed workflow — it executes `db:seed` as a one-off Cloud Run Job and is idempotent:

```bash
gh workflow run seed.yml
```

**9. (Optional) Enable the QuickBooks integration** — the QBO connect/callback/webhook routes fail closed (`503`) until credentials are wired. See the runbook below.

### Enabling the QuickBooks integration

Terraform creates the two QBO secret **containers** (`invoicing-qbo-client-secret`, `invoicing-qbo-webhook-verifier-token`) and grants the runtime service account access, but not their **values** — Intuit credentials never touch git or Terraform state. To turn the integration on:

1. In your Intuit developer app, set the OAuth **redirect URI** (and the **webhook** endpoint) to the deployed callback:
   - redirect: `https://<firebase-site>.web.app/api/integrations/qbo/callback`
   - webhook: `https://<firebase-site>.web.app/api/integrations/qbo/webhook`
2. Add the secret values — they go straight to Secret Manager, never through Terraform:

```bash
printf %s '<intuit client secret>'         | gcloud secrets versions add invoicing-qbo-client-secret --data-file=-
printf %s '<intuit webhook verifier token>' | gcloud secrets versions add invoicing-qbo-webhook-verifier-token --data-file=-
```

3. Flip `qbo_enabled` on and re-apply, passing the non-secret values (use a gitignored `*.tfvars` to keep them out of git). This rolls a new Cloud Run revision with the QBO env wired, `config.qbo` becomes non-null, and the routes go live:

```bash
terraform -chdir=infra/terraform apply \
  -var project_id=<project_id> \
  -var qbo_enabled=true \
  -var qbo_client_id='<intuit client id>' \
  -var qbo_redirect_uri='https://<firebase-site>.web.app/api/integrations/qbo/callback'
```

> Add the secret **versions** (step 2) **before** enabling — `qbo_enabled=true` with a missing version fails the Cloud Run revision. Set `-var qbo_environment=production` when moving off the Intuit sandbox.
