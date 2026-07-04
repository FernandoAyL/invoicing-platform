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

- ☐ `10010` Dashboard + invoice list/detail UI with inline sync status badge (synced / pending / conflict / failed)
  - **Done:** Backend: `apps/api/src/invoices/service.ts` `getInvoice`/`listInvoices` now LEFT JOIN `sync_links` (org-scoped, `entity_type='transaction'`, `entity_id=transactions.id`, COALESCE to `'pending'`) and expose `syncState` on `Invoice`; serialized in `apps/api/src/routes/invoices.ts`. Tests in `apps/api/src/invoices/service.test.ts` (fresh invoice -> pending, seeded synced/conflict/failed rows reflected, cross-org sync_links never leak) and a light assertion in `apps/api/src/routes/invoices.test.ts`. Frontend: extended `apps/web/src/lib/api.ts` with typed invoice/payment/contact/account methods + `apps/web/src/lib/money.ts` (`formatMoney`); new components `apps/web/src/components/{SyncStatusBadge,InvoiceStatusBadge,InvoiceLinesEditor,RecordPaymentDialog}.tsx`; new routes `apps/web/src/routes/{Invoices,InvoiceDetail,InvoiceNew,InvoiceEdit,Customers,Dashboard}.tsx` (Invoices/Dashboard rewritten from the 10009 placeholders) wired under `RequireAuth` in `apps/web/src/App.tsx` with a shared authed nav (Dashboard · Invoices · Customers · Log out). Edit/Void hidden unless `status==='open'`; overpayment 422 and void-race 409 handled inline. Component/route/api-client tests added throughout (badges all 4 states each, list rows+empty+error, create-form validation+submit+422, payment dialog submit+422, api-client method tests). Gates: `pnpm -r typecheck` clean, `pnpm -r test` 140 (api) + 50 (web) = 190 passed, `biome ci .` clean, `docker build` clean, `pnpm --filter @invoicing/web build` emits exactly `dist/{,products/,pricing/}index.html`. Runtime: full docker-compose happy path verified via curl+psql (customer -> $100 invoice -> $40 then $60 payment -> paid -> void a payment steps back to partially_paid; overpayment 422 with zero DB writes; void an open invoice) plus a real-browser Playwright pass (login, dashboard overview, invoices list, create/edit/void/record-payment/overpayment-422/not-found/customers, logout + re-guard) against the same stack.
