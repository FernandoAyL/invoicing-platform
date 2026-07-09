import { describe, expect, it } from 'vitest';
import { isBothSidesConflict, wouldUnderflowPaidAmount } from './conflict.ts';

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

describe('wouldUnderflowPaidAmount (30015)', () => {
  it('a new total below the already-applied paid amount underflows', () => {
    expect(wouldUnderflowPaidAmount(5000, 8000)).toBe(true);
  });

  it('a new total at or above the paid amount never underflows', () => {
    expect(wouldUnderflowPaidAmount(8000, 8000)).toBe(false);
    expect(wouldUnderflowPaidAmount(9000, 8000)).toBe(false);
  });

  it('no payments applied yet (paidCents 0) never underflows', () => {
    expect(wouldUnderflowPaidAmount(0, 0)).toBe(false);
  });
});
