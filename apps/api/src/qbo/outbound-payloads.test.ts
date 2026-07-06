import { describe, expect, it } from 'vitest';
import {
  buildQboAccount,
  buildQboCustomer,
  buildQboInvoice,
  buildQboItem,
  buildQboPayment,
} from './outbound-sync.ts';

describe('buildQboCustomer', () => {
  it('includes email/phone only when present', () => {
    expect(buildQboCustomer({ displayName: 'Acme Co', email: null, phone: null })).toEqual({
      DisplayName: 'Acme Co',
    });
    expect(
      buildQboCustomer({ displayName: 'Acme Co', email: 'a@acme.test', phone: '555-1234' }),
    ).toEqual({
      DisplayName: 'Acme Co',
      PrimaryEmailAddr: { Address: 'a@acme.test' },
      PrimaryPhone: { FreeFormNumber: '555-1234' },
    });
  });
});

describe('buildQboAccount', () => {
  it('maps known subtypes to their QBO AccountType regardless of the local type', () => {
    expect(buildQboAccount({ name: 'AR', type: 'asset', subtype: 'accounts_receivable' })).toEqual({
      Name: 'AR',
      AccountType: 'Accounts Receivable',
    });
    expect(buildQboAccount({ name: 'Sales', type: 'income', subtype: 'sales_income' })).toEqual({
      Name: 'Sales',
      AccountType: 'Income',
    });
  });

  it('falls back to the coarse local-type mapping when there is no known subtype', () => {
    expect(buildQboAccount({ name: 'Rent', type: 'expense', subtype: null })).toEqual({
      Name: 'Rent',
      AccountType: 'Expense',
    });
    expect(buildQboAccount({ name: 'Equity', type: 'equity', subtype: null })).toEqual({
      Name: 'Equity',
      AccountType: 'Equity',
    });
  });
});

describe('buildQboItem', () => {
  it('maps kind to QBO Type and includes UnitPrice only when a default price exists', () => {
    expect(buildQboItem({ name: 'Consulting', kind: 'service', defaultPrice: null })).toEqual({
      Name: 'Consulting',
      Type: 'Service',
    });
    expect(buildQboItem({ name: 'Widget', kind: 'inventory', defaultPrice: '19.99' })).toEqual({
      Name: 'Widget',
      Type: 'NonInventory',
      UnitPrice: 19.99,
    });
  });
});

describe('buildQboInvoice', () => {
  it('builds CustomerRef, TxnDate, and one SalesItemLineDetail line per input line', () => {
    const body = buildQboInvoice(
      { docNumber: 'INV-1', txnDate: '2026-01-01', dueDate: '2026-01-15', memo: 'Thanks' },
      [
        {
          description: 'Consulting hours',
          quantity: '2',
          unitPrice: '50.00',
          amount: '100.00',
          itemQboId: 'qbo-item-1',
        },
      ],
      'qbo-customer-1',
    );

    expect(body).toEqual({
      CustomerRef: { value: 'qbo-customer-1' },
      TxnDate: '2026-01-01',
      DocNumber: 'INV-1',
      DueDate: '2026-01-15',
      PrivateNote: 'Thanks',
      Line: [
        {
          Amount: 100,
          Description: 'Consulting hours',
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: { Qty: 2, UnitPrice: 50, ItemRef: { value: 'qbo-item-1' } },
        },
      ],
    });
  });

  it('omits ItemRef when a line has no local item, and omits optional fields when unset', () => {
    const body = buildQboInvoice(
      { docNumber: null, txnDate: '2026-01-01', dueDate: null, memo: null },
      [
        {
          description: null,
          quantity: '1',
          unitPrice: '10.00',
          amount: '10.00',
          itemQboId: null,
        },
      ],
      'qbo-customer-1',
    );

    expect(body.DocNumber).toBeUndefined();
    expect(body.DueDate).toBeUndefined();
    expect(body.PrivateNote).toBeUndefined();
    const lines = body.Line as Array<Record<string, unknown>>;
    expect(lines[0]?.Description).toBeUndefined();
    expect((lines[0]?.SalesItemLineDetail as Record<string, unknown>).ItemRef).toBeUndefined();
  });

  it('derives Amount/UnitPrice from the numeric strings via toCents, never a raw float parse', () => {
    const body = buildQboInvoice(
      { docNumber: null, txnDate: '2026-01-01', dueDate: null, memo: null },
      [{ description: null, quantity: '3', unitPrice: '33.33', amount: '99.99', itemQboId: null }],
      'qbo-customer-1',
    );
    const line = (body.Line as Array<Record<string, unknown>>)[0];
    expect(line?.Amount).toBe(99.99);
    expect((line?.SalesItemLineDetail as Record<string, unknown>).UnitPrice).toBe(33.33);
  });
});

describe('buildQboPayment', () => {
  it('builds CustomerRef, TotalAmt, and one LinkedTxn line per applied invoice', () => {
    const body = buildQboPayment({
      customerQboId: 'qbo-customer-1',
      txnDate: '2026-02-01',
      totalCents: 15000,
      linkedInvoices: [
        { qboId: 'qbo-invoice-1', amountCents: 10000 },
        { qboId: 'qbo-invoice-2', amountCents: 5000 },
      ],
    });

    expect(body).toEqual({
      CustomerRef: { value: 'qbo-customer-1' },
      TxnDate: '2026-02-01',
      TotalAmt: 150,
      Line: [
        { Amount: 100, LinkedTxn: [{ TxnId: 'qbo-invoice-1', TxnType: 'Invoice' }] },
        { Amount: 50, LinkedTxn: [{ TxnId: 'qbo-invoice-2', TxnType: 'Invoice' }] },
      ],
    });
  });
});
