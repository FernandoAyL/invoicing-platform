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

- ☐ `10009` **Frontend scaffold: React/Vite single app, public SSG routes (`/`, `/products`, `/pricing`), client-rendered auth routes** — one Vite+React+TS app (`apps/web`, `@invoicing/web`) with prerendered public marketing pages and client-rendered auth routes (login/dashboard), against the real `/api/auth/*` endpoints.
  - **Done:** Scaffolded `apps/web` (React 19 + Vite 8 + react-router-dom 7). Routing/layout in `apps/web/src/App.tsx`; public pages `apps/web/src/routes/{Home,Products,Pricing}.tsx`; auth pages `apps/web/src/routes/{Login,Dashboard,Invoices}.tsx` (Invoices is a `10010` placeholder). API client `apps/web/src/lib/api.ts` (`login`/`logout`/`me`, `credentials:'include'`), session hook `apps/web/src/lib/session.ts`, guard `apps/web/src/lib/RequireAuth.tsx` (redirects to `/login` on any failure, passes the resolved user down via render-prop children so `Dashboard` doesn't refetch). Dev proxy + `server.host:true` in `apps/web/vite.config.ts` (`API_PROXY_TARGET`, default `http://localhost:8080`). Smoke tests (Vitest+jsdom+RTL) in `apps/web/src/routes/{Home,Products,Pricing,Login}.test.tsx` and `apps/web/src/lib/RequireAuth.test.tsx` (7 tests). **SSG deviation:** `vite-ssg` is Vue-only (depends on `@unhead/vue`) — used the plan's documented fallback instead: `vite build` (client) + `vite build --ssr src/entry-server.tsx --outDir dist-ssr` + `apps/web/scripts/prerender.mjs` (renders each public route via `react-dom/server` + `StaticRouter` from `react-router-dom`, splices into the client `index.html` template, writes `dist/{,products/,pricing/}index.html`, then deletes the intermediate `dist-ssr`). Added the `web` service to `docker-compose.yml` (Vite dev server, port 5173, `API_PROXY_TARGET=http://app:8080` — the api service is named `app` in this compose file, not `api`), updated the root `Dockerfile` to also `COPY apps/web/package.json` (needed for `pnpm install --frozen-lockfile` to see the new workspace member), extended `.github/workflows/ci.yml`'s `unit-tests` job with a web vitest+JUnit step (`if: ${{ !cancelled() }}`), added `dev:web`/`build:web` to the root `package.json`, and ignored `apps/web/dist{,-ssr}` in `.gitignore`/`.dockerignore`.
