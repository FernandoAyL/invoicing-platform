import { describe, expect, it } from 'vitest';
import { isBothSidesConflict } from './conflict.ts';

describe('isBothSidesConflict', () => {
  it('both dirty: local ahead of stored AND incoming genuinely newer -> conflict', () => {
    expect(isBothSidesConflict({ storedLocalVersion: 1, txnVersion: 2 }, false)).toBe(true);
  });

  it('local clean (txnVersion === storedLocalVersion) -> not a conflict', () => {
    expect(isBothSidesConflict({ storedLocalVersion: 2, txnVersion: 2 }, false)).toBe(false);
  });

  it('local dirty but incoming is stale (ordering guard owns it) -> not a conflict', () => {
    expect(isBothSidesConflict({ storedLocalVersion: 1, txnVersion: 2 }, true)).toBe(false);
  });

  it('storedLocalVersion null (never recorded) -> never false-flags, even if incoming is newer', () => {
    expect(isBothSidesConflict({ storedLocalVersion: null, txnVersion: 5 }, false)).toBe(false);
  });

  it('local somehow behind stored (should not happen, but never throws/false-positives)', () => {
    expect(isBothSidesConflict({ storedLocalVersion: 5, txnVersion: 2 }, false)).toBe(false);
  });
});
