# To test (QA)

Tasks the developer has implemented and moved here, awaiting end-to-end QA
verification. On pass the planner moves the task to `TOCODEREVIEW.md`; on reject
it goes back to `TODO.md` with findings attached.

Keep the original task ID. Format:

```markdown
- ☐ `10005` **Title** — original description.
  - **Done:** <one-line summary, with key file paths>.
```

- ☐ `10005` **Contact CRUD (customer role first)** — name + contact info, attachable to an invoice; maps to a QBO Customer.
  - **Done:** soft-archive `is_active` migration (`apps/api/drizzle/0002_married_cassandra_nova.sql`); org-scoped service (`apps/api/src/contacts/service.ts`: create/list/get/update/archive); auth-protected Fastify routes with JSON schemas (`apps/api/src/routes/contacts.ts`, registered in `apps/api/src/app.ts`); Vitest coverage (`apps/api/src/routes/contacts.test.ts`, 17 cases). Also fixed a Fastify default (`removeAdditional: true` silently stripped unknown body fields instead of 400ing) via `ajv.customOptions.removeAdditional: false` in `apps/api/src/app.ts`.
