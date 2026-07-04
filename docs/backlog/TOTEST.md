# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

- ☐ `10008` **Audit log write path** — every mutating action appends to `SyncAuditLog` (entity, action, direction, outcome, user, timestamp).
  - **Done:** added `'local'` to the `sync_direction` enum (`apps/api/src/db/schema.ts`, migration `apps/api/drizzle/0003_gorgeous_wolf_cub.sql`); new `apps/api/src/audit/service.ts` (`writeAuditLog(db, entry)` + `AuditEntry`, defaults `direction: 'local'` / `outcome: 'success'`); `apps/api/src/contacts/service.ts` create/update/archive now run in `db.transaction` and write one audit row each (attributed to `request.user.id`, `orgId`), atomic with the mutation; `apps/api/src/routes/contacts.ts` passes `user.id` through. Tests: `apps/api/src/audit/service.test.ts` (helper defaults/pass-through) and additions to `apps/api/src/routes/contacts.test.ts` (one audit row per create/update/archive with correct fields, GET and 404 no-ops write nothing, a forced audit-insert failure rolls back the contact row too).
