import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { config } from './config.ts';
import type * as schema from './db/schema.ts';
import authPlugin from './plugins/auth.ts';
import dbPlugin from './plugins/db.ts';
import authRoutes from './routes/auth.ts';
import healthRoutes from './routes/health.ts';

export interface BuildAppOptions {
  pool?: pg.Pool;
  db?: NodePgDatabase<typeof schema>;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  app.register(dbPlugin, { pool: opts.pool, db: opts.db });
  app.register(authPlugin);
  app.register(healthRoutes);
  app.register(authRoutes);

  return app;
}
