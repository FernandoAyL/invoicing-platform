import { and, eq } from 'drizzle-orm';
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

// Minimal chart of accounts needed for the customer-invoice flow. Seeded
// idempotently per (orgId, subtype) — one account per subtype in this phase.
const seedAccounts = [
  {
    name: 'Accounts Receivable',
    type: 'asset' as const,
    subtype: 'accounts_receivable',
    code: '1200',
  },
  {
    name: 'Undeposited Funds',
    type: 'asset' as const,
    subtype: 'undeposited_funds',
    code: '1499',
  },
  { name: 'Business Checking', type: 'asset' as const, subtype: 'bank', code: '1000' },
  { name: 'Sales Income', type: 'income' as const, subtype: 'sales_income', code: '4000' },
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

  let accountsSeeded = 0;
  let accountsSkipped = 0;
  for (const acct of seedAccounts) {
    const existing = await db
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.orgId, org.id), eq(schema.accounts.subtype, acct.subtype)))
      .limit(1);
    if (existing.length > 0) {
      accountsSkipped++;
      continue;
    }
    await db.insert(schema.accounts).values({
      orgId: org.id,
      name: acct.name,
      type: acct.type,
      subtype: acct.subtype,
      code: acct.code,
    });
    accountsSeeded++;
  }
  console.log(`seeded accounts: ${accountsSeeded} created, ${accountsSkipped} already existed`);

  await pool.end();
}

await main();
