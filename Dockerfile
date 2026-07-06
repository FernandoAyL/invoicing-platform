# `dev` (last stage below) is the default build target — `docker build -t app .`
# and docker-compose both get the existing dev behaviour unchanged. CD builds the
# `runner` stage explicitly (`docker build --target runner`) for deploys; see
# .github/workflows/deploy.yml and docs/design-decisions.md#deploy-and-iac-boundary.

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# ---- production runner: only the api's prod deps + source, no build step ----
# (the api runs TS directly via Node's type stripping, same as `pnpm dev`/`start`).
FROM base AS runner

RUN pnpm install --prod --frozen-lockfile --filter @invoicing/api
COPY apps/api apps/api

EXPOSE 8080
CMD ["pnpm", "--filter", "@invoicing/api", "start"]

# ---- local dev: full workspace install + bind-mounted source (docker-compose) ----
FROM base AS dev

RUN pnpm install --frozen-lockfile
COPY . .

EXPOSE 8080
CMD ["pnpm", "--filter", "@invoicing/api", "dev"]
