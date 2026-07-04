import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.ts';

export interface AuthUser {
  id: string;
  orgId: string;
  email: string;
  role: 'admin' | 'member';
}

type Db = NodePgDatabase<typeof schema>;

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Db,
  opts: { userId: string; orgId: string; ttlHours: number },
): Promise<string> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + opts.ttlHours * 60 * 60 * 1000);
  await db.insert(schema.sessions).values({
    userId: opts.userId,
    orgId: opts.orgId,
    tokenHash: sha256Hex(token),
    expiresAt,
  });
  return token;
}

export async function findValidSession(db: Db, token: string): Promise<{ user: AuthUser } | null> {
  const tokenHash = sha256Hex(token);
  const rows = await db
    .select({
      expiresAt: schema.sessions.expiresAt,
      id: schema.users.id,
      orgId: schema.users.orgId,
      email: schema.users.email,
      role: schema.users.role,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return { user: { id: row.id, orgId: row.orgId, email: row.email, role: row.role } };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256Hex(token)));
}
