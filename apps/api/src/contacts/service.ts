import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.ts';
import { contacts } from '../db/schema.ts';

type Db = NodePgDatabase<typeof schema>;

export interface Contact {
  id: string;
  orgId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  isCustomer: boolean;
  isVendor: boolean;
  isEmployee: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateContactInput {
  displayName: string;
  email?: string;
  phone?: string;
  isCustomer?: boolean;
  isVendor?: boolean;
  isEmployee?: boolean;
}

export interface UpdateContactInput {
  displayName?: string;
  email?: string;
  phone?: string;
  isCustomer?: boolean;
  isVendor?: boolean;
  isEmployee?: boolean;
}

export interface ListContactsFilter {
  role?: 'customer' | 'vendor' | 'employee';
  includeInactive?: boolean;
}

const roleColumn = {
  customer: contacts.isCustomer,
  vendor: contacts.isVendor,
  employee: contacts.isEmployee,
} as const;

export async function createContact(
  db: Db,
  orgId: string,
  input: CreateContactInput,
): Promise<Contact> {
  const [row] = await db
    .insert(contacts)
    .values({
      orgId,
      displayName: input.displayName.trim(),
      email: input.email,
      phone: input.phone,
      isCustomer: input.isCustomer ?? true,
      isVendor: input.isVendor ?? false,
      isEmployee: input.isEmployee ?? false,
    })
    .returning();
  if (!row) throw new Error('failed to create contact');
  return row;
}

export async function listContacts(
  db: Db,
  orgId: string,
  filter: ListContactsFilter = {},
): Promise<Contact[]> {
  const conditions = [eq(contacts.orgId, orgId)];
  if (!filter.includeInactive) {
    conditions.push(eq(contacts.isActive, true));
  }
  if (filter.role) {
    conditions.push(eq(roleColumn[filter.role], true));
  }

  return db
    .select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(asc(contacts.displayName));
}

export async function getContact(db: Db, orgId: string, id: string): Promise<Contact | null> {
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateContact(
  db: Db,
  orgId: string,
  id: string,
  patch: UpdateContactInput,
): Promise<Contact | null> {
  const values: Partial<typeof contacts.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) values.displayName = patch.displayName.trim();
  if (patch.email !== undefined) values.email = patch.email;
  if (patch.phone !== undefined) values.phone = patch.phone;
  if (patch.isCustomer !== undefined) values.isCustomer = patch.isCustomer;
  if (patch.isVendor !== undefined) values.isVendor = patch.isVendor;
  if (patch.isEmployee !== undefined) values.isEmployee = patch.isEmployee;

  const [row] = await db
    .update(contacts)
    .set(values)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, id)))
    .returning();
  return row ?? null;
}

export async function archiveContact(db: Db, orgId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(contacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, id)))
    .returning({ id: contacts.id });
  return rows.length > 0;
}
