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

- ☐ `20012` **Integrations page** — connect/disconnect QBO, connection health, chronological sync activity log, manual retry of a failed item.
  - **Done:** New `GET /api/sync/activity` (org-scoped, newest-first, `?limit` 1–200 default 50) at `apps/api/src/audit/activity.ts` + `apps/api/src/routes/sync-activity.ts`, registered in `apps/api/src/app.ts`; reuses the existing connect/disconnect/status (`routes/integrations.ts`), failed-item list + retry (`routes/sync-failures.ts`), and conflicts (`routes/conflicts.ts`) endpoints as-is. Rewrote the placeholder `apps/web/src/routes/Integrations.tsx` into the real page (connection card with admin-gated Connect/Disconnect + `?connected=1`/`?error=` banners, a conflicts callout linking to `/conflicts`, a "Needs attention" failed-items list with per-row Retry, and the sync activity log) on top of the `10012` Clearbook primitives; added `qboStatus`/`connectQbo`/`disconnectQbo`/`listSyncFailures`/`retrySyncFailure`/`listSyncActivity` + types to `apps/web/src/lib/api.ts`. Tests: `apps/api/src/routes/sync-activity.test.ts` (6, org-scoping/ordering/limit-cap-and-default/empty/401 on real pglite) + `apps/web/src/routes/Integrations.test.tsx` (12, admin/member gating, connect/disconnect, retry incl. 409/503, activity ordering, conflicts callout, banners).
