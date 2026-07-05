# Clearbook design system

Source of truth for the app's visual design. Extracted from the design comp at
[`docs/design/clearbook/Clearbook.dc.html`](./design/clearbook/Clearbook.dc.html)
(open it with `support.js` alongside to render; static previews in
[`docs/design/clearbook/screenshots/`](./design/clearbook/screenshots)).

The Phase-1 styling tasks **10012–10017** adapt the existing `apps/web` UI to this
system. **Read this file + the comp before starting any styling task.**

> **Brand:** the product is branded **Clearbook** in the UI (green accounting/ledger
> mark + wordmark). The repo/package names stay `invoicing-platform` / `@invoicing/*`.

---

## Tokens

### Color

| Token | Hex | Use |
|---|---|---|
| `brand` | `#1f7a4d` | primary buttons, brand mark, links, active nav, focus |
| `brand-strong` | `#15733f` | paid/success text, emphasis on green |
| `brand-tint` | `#e7f0ea` / `#eef3f0` / `#e7f3ec` | avatar/icon chips, success pill bg |
| `brand-wash` | `#f4faf6` / `#eef7f1` | info callouts, integration icon bg |
| `canvas` | `#eef1ee` | app background |
| `surface` | `#ffffff` | cards, sidebar, topbar, inputs (elevated) |
| `surface-muted` | `#f7f9f7` / `#fbfcfb` | search input bg, table header row, inset stat tiles |
| `border` | `#e4e8e4` | card borders |
| `border-soft` | `#eef1ee` / `#f2f4f2` / `#f4f6f4` | inner dividers, row separators |
| `border-input` | `#d7ddd8` / `#dfe4e0` / `#e0e5e1` | input/select/textarea borders |
| `text` | `#14231c` | primary text |
| `text-2` | `#3a4b42` / `#4a5a51` | secondary text, mono values |
| `text-muted` | `#6b7a71` | labels, muted body |
| `text-faint` | `#8a978f` / `#9aa79f` | captions, table headers, placeholders |
| `text-disabled` | `#b3bdb5` / `#c3ccc5` | "coming soon", chevrons |
| **status: paid/success** | text `#15733f` on bg `#e7f3ec` | paid, synced, success |
| **status: open/info** | text `#1f7a4d` (neutral-green) | open invoice |
| **status: pending/warn** | `#b7791f` | pending sync, amber |
| **status: conflict/failed/void/danger** | `#c0392b` / `#b23a2c` on bg `#fdf1ef` / `#fbe9e7` | conflict, failed, void, delete-hover |

### Typography

- **UI font:** `IBM Plex Sans` (weights 400/500/600/700). System-ui fallback.
- **Mono font:** `IBM Plex Mono` (400/500/600) — used for **all numbers**: money
  amounts, invoice numbers, dates in dense rows, realm/QBO ids, quantities, rates.
  Always pair money/number cells with `font-variant-numeric: tabular-nums`.
- **Self-host** the fonts via `@fontsource/ibm-plex-sans` + `@fontsource/ibm-plex-mono`
  (do NOT add a runtime Google Fonts `<link>` — keep the app self-contained; SSG public
  pages must not depend on an external font host).
- Scale seen in the comp: page title 20–22px/700; section titles 13.5–14px/600; body
  13–13.5px; labels 10.5–11px/600 uppercase `letter-spacing:.03–.05em`; KPI/hero mono
  numbers 19–25px/600 `letter-spacing:-.02em`.

### Shape & elevation

- Radius: **cards 13–14px**, **buttons/inputs 8–9px**, small chips/tiles 6–8px, pills 999px.
- Shadows: card `0 1px 2px rgba(20,35,28,.04)`; elevated/drawer/popover `0 6px 20px rgba(20,35,28,.1)`
  (and `-8px 0 30px rgba(20,35,28,.14)` for the right-side drawer); primary button
  `0 2px 5px rgba(31,122,77,.28)`.
- Card hover (clickable): `border-color:#c9d6cd; box-shadow:0 4px 14px rgba(20,35,28,.08)`.
- Custom scrollbar: `#d3dad4` thumb, 8px radius (see comp `<style>`).

### Spacing / layout

- **Sidebar** 238px, white, right border `#e4e8e4`; **topbar** 60px, white, bottom border.
- Content area is `canvas`, scrolls; page containers use `max-width` ~1080–1180px with
  `padding: 22–26px 30px 60px`.
- Card padding 17–22px. Grid gaps 12–18px.

---

## Components (specs from the comp)

- **Button** — primary: `brand` bg, white text, radius 9, height 38–42, weight 600,
  primary shadow. Secondary: white bg, `border-input`, `text` color. Danger/ghost: text
  `#b23a2c`/`#8a5a52` on white or hover-red wash. Icon+label with 6–7px gap.
- **Card** — `surface`, `border`, radius 13–14, card shadow, optional header row with
  `border-soft` divider.
- **Badge (pill)** — small uppercase-ish label, radius 999 or 6–7. Two families:
  **status** (invoice state) and **sync** (sync state) — see mapping below.
- **Stat/KPI tile** — label row (colored dot + muted label) + big mono value + colored sub.
- **Input / Select / Textarea** — height 38–40, radius 8–9, `border-input`, 11–13px text;
  numeric inputs use mono + right align. Labels above, 11px/600 uppercase muted.
- **App shell** — sidebar (logo+wordmark, `MENU` group with icon nav items + active pill
  `brand-tint`/`brand`, a count chip on Invoices, `COMING SOON` disabled group, user chip
  pinned bottom) + topbar (page title, search input, [sync chip], primary "New invoice").
- **Table** — CSS grid rows, `surface-muted` header with faint uppercase headers, row
  hover `surface-muted`, `border-soft` separators, trailing chevron on clickable rows.
- **Right-side drawer** (customers add/edit) — fixed overlay `rgba(20,35,28,.28)`, 400px
  white panel, drawer shadow, form fields, Cancel/Save footer.
- **Empty state** — centered muted text in a card, ~60px padding.

### Status badge → invoice status

| Invoice status | Label | Colors |
|---|---|---|
| `open` | Open | neutral green `#1f7a4d` |
| `partially_paid` | Partial | amber `#b7791f` |
| `paid` | Paid | `#15733f` on `#e7f3ec` |
| `void` | Void | muted/`#8a978f` (struck/greyed) |

### Sync badge → `syncState` (from the existing `sync_links` join)

| syncState | Label | Colors |
|---|---|---|
| `pending` | Pending | amber `#b7791f` |
| `synced` | Synced | `#15733f` on `#e7f3ec` |
| `conflict` | Conflict | `#c0392b` / `#b23a2c` |
| `failed` | Failed | `#c0392b` / `#b23a2c` |

The badge component must render all four states (so Phase 2 needs no change), but in
Phase 1 every invoice is `pending` in practice.

---

## Screen → route mapping (what to restyle)

| Comp screen | Existing route/file | Task |
|---|---|---|
| App shell (sidebar+topbar) | `apps/web/src/App.tsx` `AuthedLayout` | 10012 |
| Auth (login) + public marketing | `routes/{Login,Home,Products,Pricing}.tsx` | 10013 |
| Dashboard (greeting, KPIs, recent, sync-health) | `routes/Dashboard.tsx` | 10014 |
| Invoices list (table + filters + badges) | `routes/Invoices.tsx` | 10015 |
| Create/Edit invoice (line editor + sticky summary) | `routes/{InvoiceNew,InvoiceEdit}.tsx`, `components/InvoiceLinesEditor.tsx` | 10015 |
| Invoice detail (document, totals, payments, sync card) | `routes/InvoiceDetail.tsx`, `components/RecordPaymentDialog.tsx` | 10016 |
| Customers (table + add/edit drawer) | `routes/Customers.tsx` | 10017 |
| Badges | `components/{InvoiceStatusBadge,SyncStatusBadge}.tsx` | 10012 |

---

## Phase-1 scope guards (adapt only what exists — do NOT build Phase-2 features)

The comp depicts Phase-2 surfaces. When restyling, **match the visual language but keep
Phase-1-accurate content/behavior**:

- **No QuickBooks connection yet.** The topbar "sync chip" and the dashboard/Integrations
  "Connected / last synced / realm / access token" content are Phase 2. In Phase 1: omit
  the topbar sync chip **or** render a neutral **"Not connected"** state; do not fabricate
  a connected status.
- **`Integrations` nav item** stays in the sidebar but routes to a simple **"Coming in a
  later phase" placeholder** — the full Integrations page (connection card, stats, needs-
  attention, sync activity log, resolve/retry) is **Phase 2**.
- **"Save & sync" → "Save".** Buttons must not promise a sync that doesn't happen yet.
  The create-form "On save, this posts to the ledger and syncs to QuickBooks" callout
  becomes "…posts to the ledger" (drop the sync clause).
- **Sync badges show `pending` only** in practice; the component still supports all 4 states.
- **Dashboard sync-health counts:** conflicts/failed are always 0 in Phase 1 (nothing
  syncs). Render from real data; don't hardcode the comp's sample numbers.
- **Ledger-postings card** (invoice detail): the comp shows debit/credit rows. We have
  ledger data but **no per-invoice ledger read endpoint** yet. Treat this card as
  **optional/stretch** in 10016 — include it only with a small, tested
  `GET /api/invoices/:id/ledger` read (org-scoped); otherwise defer and note it. Do not
  fake the rows.
- **Payment form fields:** keep the fields the 10007 API actually supports (amount, date,
  deposit account, and the overpayment-422 handling). Don't add persisted "method/reference"
  fields the API doesn't store — style what exists.
- **Item column:** invoice lines keep the income-account select (default Sales Income); a
  full Item catalog picker is later.
- **View toggles** (table/cards/compact on the invoices list) are a nice-to-have; the
  table layout is the Phase-1 requirement.

## Cross-cutting requirements

- **Universal primitives first (10012), then screens.** 10013–10017 reuse the 10012
  primitives + shell; do not re-implement buttons/cards/badges per screen.
- **Keep all existing behavior + tests green** — this is a restyle, not a rewrite. The
  invoice/payment/customer flows, `RequireAuth`, the httpOnly-cookie API client, and the
  public SSG build (still exactly 3 prerendered pages) must all keep working.
- **Accessibility:** real buttons/labels, visible focus states (brand focus ring), sufficient
  contrast (the muted greys on white all pass AA at these sizes).
- **QA is Playwright-driven** (visual + behavioral) per `qa.md`.
