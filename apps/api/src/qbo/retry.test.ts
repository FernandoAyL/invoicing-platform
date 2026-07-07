import { describe, expect, it } from 'vitest';
import { computeBackoff, MAX_RETRY_ATTEMPTS } from './retry.ts';

describe('computeBackoff', () => {
  it('is monotonically increasing as retryCount grows', () => {
    const delays: number[] = [];
    for (let i = 1; i < MAX_RETRY_ATTEMPTS; i++) {
      const delay = computeBackoff(i);
      expect(delay).not.toBeNull();
      delays.push(delay as number);
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] as number);
    }
  });

  it('starts at 30s for the first retry', () => {
    expect(computeBackoff(1)).toBe(30_000);
  });

  it('doubles each attempt until the cap', () => {
    expect(computeBackoff(2)).toBe(60_000);
    expect(computeBackoff(3)).toBe(120_000);
    expect(computeBackoff(4)).toBe(240_000);
  });

  it('caps at 1 hour', () => {
    const oneHourMs = 60 * 60 * 1000;
    // Attempts large enough that 30s*2^(n-1) would blow way past 1h without the cap.
    for (let i = 6; i < MAX_RETRY_ATTEMPTS; i++) {
      expect(computeBackoff(i)).toBeLessThanOrEqual(oneHourMs);
    }
  });

  it('is terminal (null) at and beyond MAX_RETRY_ATTEMPTS', () => {
    expect(computeBackoff(MAX_RETRY_ATTEMPTS)).toBeNull();
    expect(computeBackoff(MAX_RETRY_ATTEMPTS + 1)).toBeNull();
  });

  it('throws for a non-positive retryCount', () => {
    expect(() => computeBackoff(0)).toThrow(RangeError);
    expect(() => computeBackoff(-1)).toThrow(RangeError);
  });
});
