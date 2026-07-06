import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../db/schema.ts';

// Real-Postgres (in-memory, WASM) test harness. Applies the same migration files shipped to
// prod (`apps/api/drizzle/*.sql`) to a fresh PGlite instance, so tests get real column
// types/constraints/transactions instead of the hand-rolled fake db's `insert().values()` ->
// push-into-array behaviour, which silently accepted a non-uuid string into a `uuid` column
// (see `test-db.test.ts` for the regression case, and the `20015` backlog entry for the two
// `20002` bugs this harness would have caught in CI).
//
// `buildApp`/services are typed against `NodePgDatabase<typeof schema>` (the `pg` driver).
// PGlite's drizzle handle is `PgliteDatabase<typeof schema>` — a different concrete class, but
// the query/transaction surface used by this codebase (`.select()/.insert()/.update()/.delete()
// /.transaction()`) is identical at runtime. Casting here keeps the change additive: no service
// or `buildApp` signature has to change to accept a pglite db.
// `fileURLToPath` (not `.pathname`) is required so this resolves correctly on Windows, where
// `.pathname` yields a leading-slash form (`/C:/...`) that `fs` does not accept as-is.
const migrationsFolder = fileURLToPath(new URL('../../../drizzle', import.meta.url));

export interface TestDb {
  db: NodePgDatabase<typeof schema>;
  client: PGlite;
  cleanup: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const pgliteDb = drizzle(client, { schema });
  await migrate(pgliteDb, { migrationsFolder });

  return {
    db: pgliteDb as unknown as NodePgDatabase<typeof schema>,
    client,
    cleanup: () => client.close(),
  };
}

/** Minimal parent-row seed: real FKs mean an org (and usually a user) must exist before
 * inserting anything that references them. Keep this small — tests insert whatever else they
 * need directly against `db`. */
export async function seedBaseOrg(
  db: NodePgDatabase<typeof schema>,
  overrides: { name?: string } = {},
): Promise<{ orgId: string }> {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: overrides.name ?? 'Test Org' })
    .returning();
  if (!org) throw new Error('seedBaseOrg: insert returned no row');
  return { orgId: org.id };
}
