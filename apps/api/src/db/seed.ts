import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { hashPassword } from '../auth/password.ts';
import { config } from '../config.ts';
import * as schema from './schema.ts';

const ORG_NAME = 'Acme Invoicing';

const seedUsers = [
  {
    email: 'admin@invoicing.test',
    role: 'admin' as const,
    password: process.env.SEED_ADMIN_PASSWORD ?? 'password123',
  },
  {
    email: 'member@invoicing.test',
    role: 'member' as const,
    password: process.env.SEED_MEMBER_PASSWORD ?? 'password123',
  },
];

async function main() {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  const db = drizzle(pool, { schema });

  const existing = await db
    .select()
    .from(schema.organizations)
    .where(eq(schema.organizations.name, ORG_NAME))
    .limit(1);

  const org =
    existing[0] ??
    (await db.insert(schema.organizations).values({ name: ORG_NAME }).returning())[0];
  if (!org) throw new Error('failed to seed organization');

  for (const seedUser of seedUsers) {
    const passwordHash = await hashPassword(seedUser.password);
    await db
      .insert(schema.users)
      .values({ orgId: org.id, email: seedUser.email, passwordHash, role: seedUser.role })
      .onConflictDoNothing({ target: schema.users.email });
    console.log(`seeded user: ${seedUser.email} (${seedUser.role})`);
  }

  await pool.end();
}

await main();
