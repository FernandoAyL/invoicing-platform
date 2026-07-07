import { buildApp } from './app.ts';
import { config } from './config.ts';
import { runOutboundRetrySweep } from './qbo/retry-sweep.ts';

const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// 20011: the ONE place the outbound retry sweep's timer is started — deliberately not in
// `app.ts`, so `buildApp()` (what every test uses) never spawns a stray interval (§0a.7). Started
// only after `listen` succeeds, gated by `SYNC_RETRY_ENABLED`, wrapped in a never-throw catch, and
// guarded against overlapping runs (a slow sweep tick must not stack a second one on top of it).
let sweepInFlight = false;
let sweepIntervalHandle: ReturnType<typeof setInterval> | undefined;

if (config.syncRetry.enabled) {
  sweepIntervalHandle = setInterval(() => {
    if (sweepInFlight) return;
    sweepInFlight = true;
    runOutboundRetrySweep(
      app.db,
      { oauthClient: app.qboOAuthClient, apiClient: app.qboApiClient },
      new Date(),
    )
      .catch((err) => {
        app.log.error({ err }, 'outbound retry sweep failed');
      })
      .finally(() => {
        sweepInFlight = false;
      });
  }, config.syncRetry.intervalMs);
}

const shutdown = async (): Promise<void> => {
  if (sweepIntervalHandle) clearInterval(sweepIntervalHandle);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
