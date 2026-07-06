import { describe, expect, it } from 'vitest';
import {
  contactNaturalKey,
  invoiceNaturalKey,
  matchContactByNaturalKey,
  matchInvoiceByNaturalKey,
} from './natural-key.ts';

describe('contactNaturalKey', () => {
  it('keys on normalized email when present', () => {
    expect(contactNaturalKey({ email: ' Foo@Bar.com ', displayName: 'Foo Bar' })).toBe(
      'email:foo@bar.com',
    );
  });

  it('falls back to normalized display name with no email', () => {
    expect(contactNaturalKey({ displayName: ' Acme  Co ' })).toBe('name:acme  co');
  });
});

describe('matchContactByNaturalKey', () => {
  it('matches on case/space-insensitive email', () => {
    const result = matchContactByNaturalKey({ email: ' Foo@Bar.com ', displayName: 'Foo Bar' }, [
      { qboId: 'q1', email: 'someone-else@bar.com', displayName: 'Someone Else' },
      { qboId: 'q2', email: 'foo@bar.com', displayName: 'Foo Bar Inc' },
    ]);
    expect(result).toEqual({ kind: 'match', qboId: 'q2' });
  });

  it('falls back to displayName only when the local contact has no email', () => {
    const result = matchContactByNaturalKey({ displayName: 'Acme Co' }, [
      { qboId: 'q1', displayName: 'Acme Co' },
      { qboId: 'q2', displayName: 'Other Co' },
    ]);
    expect(result).toEqual({ kind: 'match', qboId: 'q1' });
  });

  it('does not fall back to displayName when the local contact has an email that matches nothing', () => {
    const result = matchContactByNaturalKey(
      { email: 'nobody@nowhere.test', displayName: 'Acme Co' },
      [{ qboId: 'q1', displayName: 'Acme Co', email: 'other@bar.com' }],
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('returns ambiguous when two candidates share the same email', () => {
    const result = matchContactByNaturalKey({ email: 'dup@bar.com', displayName: 'Acme' }, [
      { qboId: 'q1', email: 'dup@bar.com', displayName: 'Acme Inc' },
      { qboId: 'q2', email: 'dup@bar.com', displayName: 'Acme LLC' },
    ]);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.qboId).sort()).toEqual(['q1', 'q2']);
    }
  });

  it('returns ambiguous on a non-unique displayName among candidates when local has no email', () => {
    const result = matchContactByNaturalKey({ displayName: 'Acme Co' }, [
      { qboId: 'q1', displayName: 'Acme Co' },
      { qboId: 'q2', displayName: 'Acme Co' },
    ]);
    expect(result.kind).toBe('ambiguous');
  });

  it('returns none when nothing matches', () => {
    const result = matchContactByNaturalKey({ displayName: 'Acme Co' }, [
      { qboId: 'q1', displayName: 'Totally Different' },
    ]);
    expect(result).toEqual({ kind: 'none' });
  });
});

describe('invoiceNaturalKey', () => {
  it('keys on docNumber + cents + date when docNumber present', () => {
    expect(invoiceNaturalKey({ docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' })).toBe(
      'doc:INV-1:10000:2026-01-01',
    );
  });

  it('keys on cents + date alone with no docNumber', () => {
    expect(invoiceNaturalKey({ total: 100, txnDate: '2026-01-01' })).toBe('nodoc:10000:2026-01-01');
  });
});

describe('matchInvoiceByNaturalKey', () => {
  it('matches on docNumber + total + date', () => {
    const result = matchInvoiceByNaturalKey(
      { docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' },
      [
        { qboId: 'q1', docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' },
        { qboId: 'q2', docNumber: 'INV-2', total: '100.00', txnDate: '2026-01-01' },
      ],
    );
    expect(result).toEqual({ kind: 'match', qboId: 'q1' });
  });

  it('compares money as cents, not float: "100.00" matches 100 but not 100.01', () => {
    const matches = matchInvoiceByNaturalKey(
      { docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' },
      [{ qboId: 'q1', docNumber: 'INV-1', total: 100, txnDate: '2026-01-01' }],
    );
    expect(matches).toEqual({ kind: 'match', qboId: 'q1' });

    const noMatch = matchInvoiceByNaturalKey(
      { docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' },
      [{ qboId: 'q1', docNumber: 'INV-1', total: '100.01', txnDate: '2026-01-01' }],
    );
    expect(noMatch).toEqual({ kind: 'none' });
  });

  it('returns none on a total mismatch even with matching docNumber + date', () => {
    const result = matchInvoiceByNaturalKey(
      { docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' },
      [{ qboId: 'q1', docNumber: 'INV-1', total: '200.00', txnDate: '2026-01-01' }],
    );
    expect(result).toEqual({ kind: 'none' });
  });

  it('without a docNumber, requires total + date + customer to match', () => {
    const result = matchInvoiceByNaturalKey(
      { total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-1' },
      [
        { qboId: 'q1', total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-1' },
        { qboId: 'q2', total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-2' },
      ],
    );
    expect(result).toEqual({ kind: 'match', qboId: 'q1' });
  });

  it('without a docNumber and without a known customer, returns none rather than guessing', () => {
    const result = matchInvoiceByNaturalKey({ total: '100.00', txnDate: '2026-01-01' }, [
      { qboId: 'q1', total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-1' },
    ]);
    expect(result).toEqual({ kind: 'none' });
  });

  it('returns ambiguous when multiple candidates match without a docNumber', () => {
    const result = matchInvoiceByNaturalKey(
      { total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-1' },
      [
        { qboId: 'q1', total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-1' },
        { qboId: 'q2', total: '100.00', txnDate: '2026-01-01', customerQboId: 'cust-1' },
      ],
    );
    expect(result.kind).toBe('ambiguous');
  });

  it('returns none when nothing matches', () => {
    const result = matchInvoiceByNaturalKey(
      { docNumber: 'INV-1', total: '100.00', txnDate: '2026-01-01' },
      [],
    );
    expect(result).toEqual({ kind: 'none' });
  });
});
