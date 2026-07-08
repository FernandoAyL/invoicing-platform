// Machine-to-machine trigger for the outbound retry sweep, added for the Cloud Run deploy target
// (docs/architecture-decisions.md#why-cloud-run-and-how-the-retry-sweep-survives-scale-to-zero):
// Cloud Run only allocates CPU during a request, so the in-process `setInterval` in `index.ts`
// can't be relied on there (SYNC_RETRY_ENABLED=false in that environment). Cloud Scheduler POSTs
// here instead, on a fixed cadence, authenticated with a shared-secret header.
//
// Deliberately NOT behind `app.authenticate` and NOT org-scoped — it sweeps every org exactly like
// the in-process timer did. The `x-sweep-token` header is the only gate, and it fails closed
// (503) when unconfigured, matching the QBO-not-configured convention elsewhere in this codebase.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { runOutboundRetrySweep } from '../qbo/retry-sweep.ts';

function isValidToken(header: unknown, expected: string): boolean {
  if (typeof header !== 'string') return false;
  const headerBuf = Buffer.from(header);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on mismatched lengths — check that first rather than let a length
  // difference short-circuit into an early (timing-observable) return.
  if (headerBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(headerBuf, expectedBuf);
}

export default async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/internal/retry-sweep', async (request, reply) => {
    const token = config.internalSweepToken;
    if (!token) {
      reply.code(503).send({ error: 'sweep_not_configured' });
      return;
    }

    if (!isValidToken(request.headers['x-sweep-token'], token)) {
      reply.code(401).send({ error: 'invalid_sweep_token' });
      return;
    }

    const summary = await runOutboundRetrySweep(
      app.db,
      { oauthClient: app.qboOAuthClient, apiClient: app.qboApiClient },
      new Date(),
    );
    reply.send(summary);
  });
}
