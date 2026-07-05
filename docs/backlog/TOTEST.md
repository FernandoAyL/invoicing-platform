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

- ☐ `10013` **Auth + public marketing restyle** — restyle `Login` (centered branded auth card) and the public SSG pages `Home`/`Products`/`Pricing` to the Clearbook brand. Public pages must stay prerendered and network-free; login flow behaviour unchanged.
  - **Done:** New shared marketing chrome in `apps/web/src/components/marketing/PublicLayout.tsx` — restyled public top nav (Clearbook `Logo` + Products/Pricing links + `Sign in` CTA) + footer wrapping `/`, `/products`, `/pricing`, plus a `CtaLink` link-styled-as-button (reuses the shared `.ui-btn` classes, correct `<Link>` element for route changes) and a `MarketingSection` centered content column. Restyled `routes/Home.tsx` (hero: Clearbook eyebrow + h1 "The invoicing platform that stays in sync" + CTAs + 3 feature `Card`s), `routes/Products.tsx` (3 product `Card`s), `routes/Pricing.tsx` (single "Standard $29/mo" pricing `Card` with an included-features list + CTA). Restyled `routes/Login.tsx` into a **standalone centered branded auth card** (`Logo` + `Card` + `Input` + `Button`, inline `role="alert"` error) — `me()` session-skip, `login()`, navigate, submit-state, and generic-error behaviour preserved verbatim. `App.tsx` now wraps the marketing routes in `PublicLayout` and renders `/login` standalone (no marketing chrome). **Verified (automated):** `vitest` 50/50 web (Pricing test wrapped in `MemoryRouter` like Home's, assertion unchanged), `tsc --noEmit` clean, `biome ci` clean, SSG build still emits **exactly the 3** prerendered pages (`/`, `/products`, `/pricing`) with the restyled content present in the static HTML and no network calls (Login is not prerendered). **Not yet run this session:** live Playwright visual QA (no Playwright MCP connected).
