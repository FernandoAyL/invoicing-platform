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

- ☐ `10017` **Customers restyle** — customers table (avatar initials, contact, invoice count, balance, sync badge, delete) + add-customer right-side drawer. Edit **deferred** (needs a new update endpoint).
  - **Done:** Restyled `routes/Customers.tsx` onto the 10012 primitives/shell. `PageHeader` "Customers" + an **Add customer** primary button (opens the drawer). A `Card`-wrapped CSS-grid **table**: per-row **avatar initials** chip (brand-tint), name + email/phone sub, **Invoices** count + **Balance** (both aggregated per `contactId` from `listInvoices()` — no new endpoint, same approach as the dashboard), a Phase-1 `SyncStatusBadge state="pending"` (contacts have no syncState field yet — this is the honest fixed Phase-1 state, consistent with the invoice screens), and an **Archive** ghost/danger action (the real API delete-equivalent). Loading/error via `LoadingState`/`ErrorState`, empty state via `EmptyState`. The **add/edit slide-over drawer** is built as a right-side drawer (fixed `rgba(20,35,28,.28)` overlay, 400px white panel, `shadow.drawer`, Name/Email/Phone via `Input`, Cancel/Add-customer footer) — wired for **create** (existing `createContact`, now passing the API-supported `phone` too) + `role="dialog"`/`aria-modal`. **Scope decisions (style what exists):** the comp's **city** field is omitted (not persisted by the API); **row-level edit is DEFERRED** — there is no `updateContact`/`PATCH /api/contacts/:id` endpoint, and adding one is a backend change beyond this restyle (same call as the deferred ledger card), so archive (delete) is the row action and the drawer is create-only. No API change. **Verified:** web `vitest` 50/50, `tsc` + `biome ci` clean (backdrop-click-to-close omitted for the same a11y reason as the payment modal), SSG unchanged (auth-gated — still 3 public pages). **Live Playwright visual QA** (route-stubbed): table (avatar chips, Acme 2 invoices/$2,125.50, Globex 1/$400, Initech 0/$0, Pending badges, Archive), the **right-side Add-customer drawer** (Name/Email/Phone filled), and the empty state all render correctly in the shell. **Completes the Clearbook restyle sub-phase (10012–10017).**
