import { describe, expect, it } from 'vitest';
import { deriveInvoiceStatus } from './status.ts';

describe('deriveInvoiceStatus', () => {
  it('returns open when nothing has been paid', () => {
    expect(deriveInvoiceStatus(10000, 0)).toBe('open');
  });

  it('returns open for a negative paid amount (defensive)', () => {
    expect(deriveInvoiceStatus(10000, -1)).toBe('open');
  });

  it('returns partially_paid when paid is between 0 and total', () => {
    expect(deriveInvoiceStatus(10000, 4000)).toBe('partially_paid');
  });

  it('returns paid when paid equals total exactly', () => {
    expect(deriveInvoiceStatus(10000, 10000)).toBe('paid');
  });

  it('returns paid when paid exceeds total (guarded upstream, but derivation is defensive)', () => {
    expect(deriveInvoiceStatus(10000, 10001)).toBe('paid');
  });

  it('is boundary-exact at 1 cent under total (partially_paid)', () => {
    expect(deriveInvoiceStatus(10000, 9999)).toBe('partially_paid');
  });

  it('is boundary-exact at 1 cent paid (partially_paid, not open)', () => {
    expect(deriveInvoiceStatus(10000, 1)).toBe('partially_paid');
  });

  it('handles a zero-total invoice as paid once anything is applied', () => {
    expect(deriveInvoiceStatus(0, 0)).toBe('open');
    expect(deriveInvoiceStatus(0, 1)).toBe('paid');
  });
});
