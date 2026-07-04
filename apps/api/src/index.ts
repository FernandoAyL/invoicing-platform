import { buildApp } from './app.ts';
import { config } from './config.ts';

const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
