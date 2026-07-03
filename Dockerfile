# Local dev image. A multi-stage production build comes with the deploy work.
FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 8080
CMD ["pnpm", "--filter", "@invoicing/api", "dev"]
