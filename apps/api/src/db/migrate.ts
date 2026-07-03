import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { config } from '../config.ts';

const pool = new pg.Pool({ connectionString: config.databaseUrl });
const db = drizzle(pool);

await migrate(db, { migrationsFolder: './drizzle' });
await pool.end();
console.log('migrations applied');
