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

- ☐ `20003` **Refetch: when a webhook payload is incomplete, fetch full invoice/payment state from QBO before applying** — establishes the QBO data-API read client + refetch primitive that `20004`/`20007` consume.
  - **Done:** Injectable `QboApiClient` (`apps/api/src/qbo/api-client.ts`, `createQboApiClient`) does `GET /v3/company/{realmId}/{entityType}/{qboId}?minorversion=73` with `Authorization: Bearer`/`Accept: application/json`, base URL from `config.qbo.environment` (sandbox/production); maps 401→`QboAuthError`, 404→`QboNotFoundError`, 429/5xx→`QboApiError{retryable:true}`, other non-2xx/malformed-200→`QboApiError{retryable:false}` (`apps/api/src/qbo/errors.ts`, plain-field constructors, no parameter properties). `refetchEntity` (`apps/api/src/qbo/refetch.ts`) resolves a fresh token+realm via `getValidAccessToken` (20001) then calls `apiClient.getEntity`; `mapNotificationToEntityType` maps a webhook entity `name` to `QboEntityType` (null for unsynced types). Wired as `BuildAppOptions.qboApiClient` / `app.qboApiClient` mirroring the `qboOAuthClient` seam (`apps/api/src/plugins/qbo.ts`, `apps/api/src/app.ts`). No route, no webhook wiring, no DB writes — library primitive only (20007 applies it). Tests: `api-client.test.ts` (fake fetch, all status-mapping + envelope-parse cases), `refetch.test.ts` (`createTestDb()`/`seedBaseOrg()` + fake oauth/api clients — token-refresh path, no-connection, typed-error propagation, notification mapping). `docs/design-decisions.md` updated with the read-client + always-refetch rationale + error taxonomy.
