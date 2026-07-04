import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { createSession, deleteSession } from '../auth/session.ts';
import { config } from '../config.ts';
import { users } from '../db/schema.ts';
import { SESSION_COOKIE } from '../plugins/auth.ts';

// Precomputed once so a login with an unknown email still pays the full scrypt
// cost, closing the timing side-channel that would otherwise reveal whether
// the email exists.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing-safety');

const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', minLength: 1 },
  },
} as const;

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      const { email, password } = request.body;

      const rows = await app.db.select().from(users).where(eq(users.email, email)).limit(1);
      const user = rows[0];

      const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) {
        reply.code(401).send({ error: 'invalid_credentials' });
        return;
      }

      const token = await createSession(app.db, {
        userId: user.id,
        orgId: user.orgId,
        ttlHours: config.sessionTtlHours,
      });

      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: config.nodeEnv === 'production',
        signed: true,
        maxAge: config.sessionTtlHours * 60 * 60,
      });

      return { id: user.id, email: user.email, role: user.role };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE];
    const token = raw ? request.unsignCookie(raw) : null;
    if (token?.valid && token.value) {
      await deleteSession(app.db, token.value);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.code(204);
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    // authenticate() has already replied 401 for any unauthenticated request.
    const user = request.user;
    if (!user) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }
    return { id: user.id, email: user.email, role: user.role };
  });
}
