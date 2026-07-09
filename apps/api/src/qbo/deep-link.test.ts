import { describe, expect, it } from 'vitest';
import { qboEntityUrl } from './deep-link.ts';

describe('qboEntityUrl', () => {
  it('builds a sandbox invoice deep link', () => {
    expect(qboEntityUrl('sandbox', 'Invoice', '42')).toBe(
      'https://app.sandbox.qbo.intuit.com/app/invoice?txnId=42',
    );
  });

  it('builds a production customer deep link', () => {
    expect(qboEntityUrl('production', 'Customer', '7')).toBe(
      'https://app.qbo.intuit.com/app/customerdetail?nameId=7',
    );
  });

  it('url-encodes the id', () => {
    expect(qboEntityUrl('production', 'Customer', 'a b/c')).toBe(
      'https://app.qbo.intuit.com/app/customerdetail?nameId=a%20b%2Fc',
    );
  });

  it('returns null when the id is missing (never linked)', () => {
    expect(qboEntityUrl('sandbox', 'Invoice', null)).toBeNull();
    expect(qboEntityUrl('sandbox', 'Invoice', undefined)).toBeNull();
  });

  it('returns null for an entity type with no known detail page', () => {
    expect(qboEntityUrl('sandbox', 'Account', '1')).toBeNull();
  });
});
