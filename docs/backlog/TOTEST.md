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

- ☐ `10012` **Design system foundation + app shell** — self-host IBM Plex Sans/Mono (`@fontsource/*`), define the Clearbook design tokens (color/type/shape/spacing) as a theme module + CSS variables, global base styles (canvas bg, scrollbars), the Clearbook brand mark + wordmark, and the shared **authed app shell** (238px sidebar with icon nav + active state + Invoices count + `COMING SOON` group + user chip; 60px topbar with page title + search + primary "New invoice") replacing the current plain `AuthedLayout`. Plus the core reusable primitives: `Button` (primary/secondary/danger), `Card`, `Input`/`Select`/`Textarea`, `PageHeader`, empty/loading/error states, and the restyled `InvoiceStatusBadge` + `SyncStatusBadge` (all 4 states each). Everything in `10013`–`10017` reuses these — no per-screen re-implementation.
  - **Done:** Self-hosted fonts via `@fontsource/ibm-plex-{sans,mono}` latin-only subsets imported in `apps/web/src/main.tsx`; tokens in `apps/web/src/theme.ts` + `apps/web/src/styles/global.css` (`:root` custom properties, base/reset/scrollbar, and the `.ui-*` interactive-state classes that own hover/focus so an inline style is never fighting a stylesheet rule). New `apps/web/src/components/ui/{Logo,Button,Card,Input,Select,Textarea,FieldLabel,PageHeader,DataState,index}.tsx` primitives. New shell in `apps/web/src/components/shell/{Sidebar,Topbar,AppShell,icons,page-title}.tsx`, wired into `apps/web/src/App.tsx` (replaces the old `AuthedLayout`; auth is now guarded once at the shell level and `user` flows to `Dashboard` via `Outlet` context instead of a second `RequireAuth`/session fetch). New placeholder route `apps/web/src/routes/Integrations.tsx`. Restyled `apps/web/src/components/{InvoiceStatusBadge,SyncStatusBadge}.tsx` to the design-system pill colors (props/labels/tests unchanged). Topbar sync chip renders a neutral "Not connected" state per the Phase-1 scope guard; Integrations nav routes to the placeholder.
