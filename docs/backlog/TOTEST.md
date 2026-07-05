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

- ☐ `10015` **Invoices list + create/edit restyle** — the invoices **table** layout with filter tabs; and the create/edit invoice surface (line rows + "Add line" + sticky **Summary** panel).
  - **Done:** Restyled `routes/Invoices.tsx` into a Clearbook **table** — filter tabs (All/Open/Partially paid/Paid/Void with live counts, active pill), a `Card`-wrapped CSS-grid table (`surface-muted` faint-uppercase header row; per-row mono doc#, customer, mono date, right-aligned `tabular-nums` total + balance, `InvoiceStatusBadge` + `SyncStatusBadge`, trailing chevron, `.ui-table-row` hover, row → detail), a per-filter empty message, and the zero-invoices `EmptyState` ("Create your first invoice"); load/error via `LoadingState`/`ErrorState`. Restyled `components/InvoiceLinesEditor.tsx` — aligned grid line rows (Description/Qty/Unit price/**Amount** live per-line + × remove) via the `Input` primitive (qty/price `mono`) + a "+ Add line" `Button` (**aria-labels + all exports preserved**; moved the old inline total into the page Summary). New `components/InvoiceSummary.tsx` — the sticky right-hand **Summary** panel (Subtotal + Total from `computeDraftTotal`, inline `role=alert` error slot, submit-button slot). Rebuilt `routes/InvoiceNew.tsx` + `routes/InvoiceEdit.tsx` on a two-column layout (Details `Card` + Line items `Card` on the left, `InvoiceSummary` on the right) using `PageHeader`/`Select`/`Input`/`Button`; New keeps the add-customer prompt, customer `<option>`s, "Create invoice" (disabled w/ no customers); Edit keeps the load/not-found/non-open guards + "Save changes". **Scope guard:** no "Save & sync" (never existed; buttons stay "Create invoice"/"Save changes"), and the New subtitle is "Post a customer invoice to the ledger" — no sync clause. No API change. **Verified:** web `vitest` 50/50 (Invoices + InvoiceNew contracts intact), `tsc` + `biome ci` clean, SSG unchanged (auth-gated, not prerendered — still 3 public pages). **Live Playwright visual QA** (route-stubbed auth + contacts + invoices): list (populated + `Open`-filtered + empty), New (live Amount $1,000 = 10×100 + Summary tracking), Edit (2 lines loaded → Total $1,450) all render correctly in the shell.
