import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    try {
      await app.pool.query('SELECT 1');
      return { status: 'ok', db: 'up' };
    } catch {
      reply.code(503);
      return { status: 'degraded', db: 'down' };
    }
  });
}
