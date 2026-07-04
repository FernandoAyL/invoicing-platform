import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { config } from './config.ts';
import dbPlugin from './plugins/db.ts';
import healthRoutes from './routes/health.ts';

export interface BuildAppOptions {
  pool?: pg.Pool;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
  });

  app.register(dbPlugin, { pool: opts.pool });
  app.register(healthRoutes);

  return app;
}
