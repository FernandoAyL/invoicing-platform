import { describe, expect, it } from 'vitest';
import { isStaleInboundApply, parseSyncToken } from './ordering.ts';

describe('parseSyncToken', () => {
  it('parses a numeric string', () => {
    expect(parseSyncToken('3')).toBe(3);
    expect(parseSyncToken('0')).toBe(0);
  });

  it('returns null for missing/undefined/non-numeric input, never throws', () => {
    expect(parseSyncToken(undefined)).toBeNull();
    expect(parseSyncToken(null)).toBeNull();
    expect(parseSyncToken('')).toBeNull();
    expect(() => parseSyncToken('not-a-number')).not.toThrow();
    expect(parseSyncToken('not-a-number')).toBeNull();
  });
});

describe('isStaleInboundApply — SyncToken primary comparator', () => {
  it('incoming > stored -> not stale (apply)', () => {
    expect(isStaleInboundApply({ storedSyncToken: '2' }, { incomingSyncToken: '3' })).toBe(false);
  });

  it('incoming === stored -> stale (skip, idempotent re-apply)', () => {
    expect(isStaleInboundApply({ storedSyncToken: '3' }, { incomingSyncToken: '3' })).toBe(true);
  });

  it('incoming < stored -> stale (skip)', () => {
    expect(isStaleInboundApply({ storedSyncToken: '3' }, { incomingSyncToken: '2' })).toBe(true);
  });
});

describe('isStaleInboundApply — first sync (no stored comparator at all)', () => {
  it('no stored token and no stored lastSyncedAt -> never stale, always apply', () => {
    expect(isStaleInboundApply({}, {})).toBe(false);
    expect(
      isStaleInboundApply(
        {},
        { incomingSyncToken: '1', incomingLastUpdated: '2026-01-01T00:00:00Z' },
      ),
    ).toBe(false);
  });
});

describe('isStaleInboundApply — timestamp fallback when a SyncToken is missing', () => {
  it('stored has a timestamp, incoming SyncToken missing -> falls back to timestamp compare (newer -> apply)', () => {
    expect(
      isStaleInboundApply(
        { storedLastSyncedAt: new Date('2026-01-01T00:00:00Z') },
        { incomingLastUpdated: '2026-01-02T00:00:00Z' },
      ),
    ).toBe(false);
  });

  it('stored has a timestamp, incoming SyncToken missing -> falls back to timestamp compare (older -> stale)', () => {
    expect(
      isStaleInboundApply(
        { storedLastSyncedAt: new Date('2026-01-02T00:00:00Z') },
        { incomingLastUpdated: '2026-01-01T00:00:00Z' },
      ),
    ).toBe(true);
  });

  it('stored SyncToken missing, incoming has one, but stored has a timestamp -> still falls back to timestamps', () => {
    expect(
      isStaleInboundApply(
        { storedLastSyncedAt: new Date('2026-01-02T00:00:00Z') },
        { incomingSyncToken: '5', incomingLastUpdated: '2026-01-01T00:00:00Z' },
      ),
    ).toBe(true);
  });

  it('stored has a timestamp, incoming has neither a SyncToken nor a timestamp -> conservatively apply', () => {
    expect(isStaleInboundApply({ storedLastSyncedAt: new Date('2026-01-01T00:00:00Z') }, {})).toBe(
      false,
    );
  });
});

describe('isStaleInboundApply — garbage SyncToken never throws', () => {
  it('non-numeric stored token falls back to timestamp path', () => {
    expect(() =>
      isStaleInboundApply(
        { storedSyncToken: 'garbage', storedLastSyncedAt: new Date('2026-01-02T00:00:00Z') },
        { incomingSyncToken: '5', incomingLastUpdated: '2026-01-01T00:00:00Z' },
      ),
    ).not.toThrow();
    expect(
      isStaleInboundApply(
        { storedSyncToken: 'garbage', storedLastSyncedAt: new Date('2026-01-02T00:00:00Z') },
        { incomingSyncToken: '5', incomingLastUpdated: '2026-01-01T00:00:00Z' },
      ),
    ).toBe(true);
  });

  it('non-numeric incoming token falls back to timestamp path', () => {
    expect(
      isStaleInboundApply(
        { storedSyncToken: '3', storedLastSyncedAt: new Date('2026-01-01T00:00:00Z') },
        { incomingSyncToken: 'garbage', incomingLastUpdated: '2026-01-02T00:00:00Z' },
      ),
    ).toBe(false);
  });
});
