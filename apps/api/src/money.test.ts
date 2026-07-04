import { describe, expect, it } from 'vitest';
import { formatCents, toCents } from './money.ts';

describe('toCents', () => {
  it('parses whole and fractional string amounts', () => {
    expect(toCents('100')).toBe(10000);
    expect(toCents('100.5')).toBe(10050);
    expect(toCents('100.50')).toBe(10050);
    expect(toCents('0.10')).toBe(10);
    expect(toCents('0')).toBe(0);
  });

  it('parses number amounts', () => {
    expect(toCents(100)).toBe(10000);
    expect(toCents(100.5)).toBe(10050);
    expect(toCents(0.1)).toBe(10);
  });

  it('parses negative amounts', () => {
    expect(toCents('-5.00')).toBe(-500);
    expect(toCents(-5)).toBe(-500);
  });

  it('avoids float drift: 0.10 + 0.20 sums to the same cents as 0.30', () => {
    expect(toCents('0.10') + toCents('0.20')).toBe(toCents('0.30'));
  });

  it('throws on malformed strings', () => {
    expect(() => toCents('abc')).toThrow(RangeError);
    expect(() => toCents('1.234')).toThrow(RangeError);
    expect(() => toCents('')).toThrow(RangeError);
  });

  it('throws on NaN/non-finite numbers', () => {
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('formatCents', () => {
  it('round-trips through toCents', () => {
    expect(formatCents(toCents('100'))).toBe('100.00');
    expect(formatCents(toCents('100.5'))).toBe('100.50');
    expect(formatCents(toCents('0.10'))).toBe('0.10');
  });

  it('formats negative cents', () => {
    expect(formatCents(-500)).toBe('-5.00');
  });

  it('throws on non-integer cents', () => {
    expect(() => formatCents(10.5)).toThrow(RangeError);
  });
});
