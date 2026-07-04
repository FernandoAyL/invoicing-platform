import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { accounts } from '../db/schema.ts';

type Db = NodePgDatabase<typeof schema>;

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface Account {
  id: string;
  orgId: string;
  code: string | null;
  name: string;
  type: AccountType;
  subtype: string | null;
  parentId: string | null;
  currency: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListAccountsFilter {
  includeInactive?: boolean;
  type?: AccountType;
}

export async function listAccounts(
  db: Db,
  orgId: string,
  filter: ListAccountsFilter = {},
): Promise<Account[]> {
  const conditions = [eq(accounts.orgId, orgId)];
  if (!filter.includeInactive) {
    conditions.push(eq(accounts.isActive, true));
  }
  if (filter.type) {
    conditions.push(eq(accounts.type, filter.type));
  }

  return db
    .select()
    .from(accounts)
    .where(and(...conditions))
    .orderBy(asc(accounts.code), asc(accounts.name));
}

// Assumes at most one account per (orgId, subtype), true for the minimal
// chart seeded in this phase. Multiple accounts per subtype (e.g. several
// bank accounts) is out of scope until account selection is designed.
export async function getAccountBySubtype(
  db: Db,
  orgId: string,
  subtype: string,
): Promise<Account | null> {
  const rows = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.subtype, subtype)))
    .limit(1);
  return rows[0] ?? null;
}
