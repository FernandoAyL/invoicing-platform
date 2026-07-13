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

- ☐ `10019` **Customer edit** — add `PATCH /api/contacts/:id` (org-scoped update of displayName/email/phone, with a test) + a client `updateContact`, then wire the existing customers add-drawer (10017) for **edit** as well as create (prefill + save). The slide-over UI is already built; this only adds the update path.
  - **Done:** frontend-only, per the plan's scope correction — `PATCH /api/contacts/:id` + `updateContact` service already existed (task 10005). Added `updateContact(id, input)` to `apps/web/src/lib/api.ts` (mirrors `createContact`). Wired `apps/web/src/routes/Customers.tsx`'s existing add-drawer for edit: new `editingId` state, `openEditDrawer(customer)` prefills displayName/email/phone, an "Edit" row action next to "Archive", `handleSubmit` branches create/update, drawer title/button/aria-label swap by mode. New `apps/web/src/routes/Customers.test.tsx` (5 tests: edit prefill, submit calls `updateContact` + reloads, cancel doesn't call the API, create path unaffected, update-rejection shows inline error and keeps the drawer open).
