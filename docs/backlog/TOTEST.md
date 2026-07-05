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

- ☐ `10014` **Dashboard restyle** — greeting header, KPI stat cards (outstanding A/R, counts by invoice status), a "Recent invoices" list, and a sync-health card. Render from real data (conflicts/failed are 0 in Phase 1; no fabricated "connected" status).
  - **Done:** Restyled `apps/web/src/routes/Dashboard.tsx` onto the 10012 primitives — greeting header ("Welcome back, <name>" + email + role), a responsive row of KPI `StatTile`s (Outstanding A/R in brand-green mono + N-unpaid sub, Open / Partially paid / Paid counts with colored dots), a **Recent invoices** `Card` (up to 5 rows: mono docNumber + right-aligned tabular-nums total + `InvoiceStatusBadge`, hover, `View all` → /invoices, empty-state "Create your first invoice"), and a **Sync health** `Card` (all four `SyncStatusBadge` states with **real counts** derived from each invoice's `syncState` — Phase-1 conflict/failed fall out as 0 from the data, not hardcoded — plus an honest "Not connected to QuickBooks yet" note linking to Integrations; **no fabricated connected status**). Same client-derived aggregation + load/`role=status`/`role=alert` semantics as before (now via `LoadingState`/`ErrorState`). No API change (reads the 10010 `listInvoices` + `syncState`). **Verified:** web `vitest` 50/50, `tsc` + `biome ci` clean, SSG unchanged (Dashboard is auth-gated, not prerendered — still exactly 3 public pages). **Live Playwright visual QA** (stubbed `/api/auth/me` + `/api/invoices`) — populated state (Outstanding A/R $2,525.50 = 1450+400+675.50, Open 2 / Partial 1 / Paid 2, 3 unpaid, sync Pending 5 / Synced 1 / Conflict 0 / Failed 0) and empty state ($0.00, zeros, create-first-invoice) both render correctly inside the shell.
