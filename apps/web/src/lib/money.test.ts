import { describe, expect, it } from 'vitest';
import { formatMoney } from './money.ts';

describe('formatMoney', () => {
  it('formats a plain server string as USD', () => {
    expect(formatMoney('100.00')).toBe('$100.00');
  });

  it('formats a number and adds thousands separators', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
  });

  it('formats zero', () => {
    expect(formatMoney('0.00')).toBe('$0.00');
  });

  it('formats a negative amount', () => {
    expect(formatMoney('-50.00')).toBe('-$50.00');
  });

  it('falls back to the raw input for a non-numeric string', () => {
    expect(formatMoney('n/a')).toBe('n/a');
  });
});
