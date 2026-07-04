import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import fp from 'fastify-plugin';
import pg from 'pg';
import { config } from '../config.ts';
import * as schema from '../db/schema.ts';

export interface DbPluginOptions {
  pool?: pg.Pool;
  db?: NodePgDatabase<typeof schema>;
}

declare module 'fastify' {
  interface FastifyInstance {
    pool: pg.Pool;
    db: NodePgDatabase<typeof schema>;
  }
}

export default fp<DbPluginOptions>(async (app, opts) => {
  const pool = opts.pool ?? new pg.Pool({ connectionString: config.databaseUrl });
  const db = opts.db ?? drizzle(pool, { schema });

  app.decorate('pool', pool);
  app.decorate('db', db);

  // Only own the lifecycle of pools we created (injected pools are the caller's).
  if (!opts.pool) {
    app.addHook('onClose', async () => {
      await pool.end();
    });
  }
});
