import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { type AuthUser, findValidSession } from '../auth/session.ts';
import { config } from '../config.ts';

// Named `__session` deliberately: Firebase Hosting (which fronts the API via its /api/** rewrite in
// the deployed environment) strips every request cookie EXCEPT one literally named `__session`, so
// any other name is set at login but never reaches Cloud Run on the next request — auth then
// silently 401s. See docs/architecture-decisions.md "Frontend deployment".
export const SESSION_COOKIE = '__session';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (
      role: AuthUser['role'],
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(cookie, { secret: config.sessionSecret });

  app.decorateRequest('user', null);

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.cookies[SESSION_COOKIE];
    const token = raw ? request.unsignCookie(raw) : null;
    if (!raw || !token?.valid || !token.value) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }

    const session = await findValidSession(app.db, token.value);
    if (!session) {
      reply.code(401).send({ error: 'unauthenticated' });
      return;
    }

    request.user = session.user;
  });

  app.decorate('requireRole', (role: AuthUser['role']) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      if (reply.sent) return;
      if (request.user?.role !== role) {
        reply.code(403).send({ error: 'forbidden' });
      }
    };
  });
});
