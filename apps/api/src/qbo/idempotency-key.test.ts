import { describe, expect, it } from 'vitest';
import { outboundIdempotencyKey } from './idempotency-key.ts';

describe('outboundIdempotencyKey', () => {
  const base = {
    orgId: 'org-a',
    entityType: 'transaction',
    localId: 'txn-1',
    localVersion: 1,
  };

  it('is deterministic for identical inputs', () => {
    expect(outboundIdempotencyKey(base)).toBe(outboundIdempotencyKey({ ...base }));
  });

  it('is stable in shape', () => {
    expect(outboundIdempotencyKey(base)).toBe('org-a:transaction:txn-1:v1');
  });

  it('produces distinct keys for distinct orgId/entityType/localId', () => {
    expect(outboundIdempotencyKey(base)).not.toBe(
      outboundIdempotencyKey({ ...base, orgId: 'org-b' }),
    );
    expect(outboundIdempotencyKey(base)).not.toBe(
      outboundIdempotencyKey({ ...base, entityType: 'contact' }),
    );
    expect(outboundIdempotencyKey(base)).not.toBe(
      outboundIdempotencyKey({ ...base, localId: 'txn-2' }),
    );
  });

  it('produces a distinct key when localVersion changes (retry-of-same-version reuses the key, a later version does not)', () => {
    const attempt1 = outboundIdempotencyKey(base);
    const retryOfAttempt1 = outboundIdempotencyKey({ ...base });
    const attempt2 = outboundIdempotencyKey({ ...base, localVersion: 2 });

    expect(retryOfAttempt1).toBe(attempt1);
    expect(attempt2).not.toBe(attempt1);
  });
});
