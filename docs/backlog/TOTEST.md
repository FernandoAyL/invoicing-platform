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

- ☐ `20001` **QBO OAuth: connect/disconnect flow, token storage in `QboConnection`, automatic token refresh** — foundation task for the QBO sync engine.
  - **Done:** injectable `QboOAuthClient` (`apps/api/src/qbo/oauth-client.ts`, real Intuit HTTP client + interface for test stubs), stateless signed `state` CSRF (`apps/api/src/qbo/oauth-state.ts`), `QboConnection` DB layer + the reusable `getValidAccessToken(db, client, orgId)` primitive (`apps/api/src/qbo/connection-service.ts`), typed errors (`apps/api/src/qbo/errors.ts`), admin-gated routes under `/api/integrations/qbo/{connect,callback,status,disconnect}` (`apps/api/src/routes/integrations.ts`), a `qboPlugin` decorating `app.qboOAuthClient` from `config.qbo` or an injected stub/null (`apps/api/src/plugins/qbo.ts`), `BuildAppOptions.qboOAuthClient` wiring in `apps/api/src/app.ts`. `config.qbo` is optional/nullable (`apps/api/src/config.ts`) — routes 503 `qbo_not_configured` when unset. New env vars `QUICKBOOKS_REDIRECT_URI`/`QUICKBOOKS_ENVIRONMENT` in `.env.example` + `docker-compose.yml`. Design note added to `docs/design-decisions.md` (## QBO OAuth). Unit + HTTP tests: `apps/api/src/qbo/{oauth-client,oauth-state,connection-service}.test.ts`, `apps/api/src/routes/integrations.test.ts`, plus `config.test.ts` additions — all against an injected stub client, no live Intuit calls.
