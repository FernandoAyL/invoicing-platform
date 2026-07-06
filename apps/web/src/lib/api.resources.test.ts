import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveContact,
  createContact,
  createInvoice,
  getContact,
  getInvoice,
  listAccounts,
  listConflicts,
  listContacts,
  listInvoices,
  listPayments,
  recordPayment,
  resolveConflict,
  updateInvoice,
  voidInvoice,
  voidPayment,
} from './api.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('api resource methods', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listInvoices hits GET /api/invoices with no query when unfiltered', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listInvoices();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices');
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('listInvoices appends a status filter', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listInvoices({ status: 'open' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices?status=open');
  });

  it('getInvoice hits GET /api/invoices/:id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'inv-1' }));
    await getInvoice('inv-1');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices/inv-1');
  });

  it('createInvoice POSTs the input as JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'inv-1' }, 201));
    const input = {
      contactId: 'contact-1',
      txnDate: '2026-07-04',
      lines: [{ quantity: 1, unitPrice: 100 }],
    };
    await createInvoice(input);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('updateInvoice PATCHes /api/invoices/:id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'inv-1' }));
    await updateInvoice('inv-1', { memo: 'net 30' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices/inv-1');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ memo: 'net 30' }));
  });

  it('voidInvoice POSTs to /api/invoices/:id/void with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'inv-1', status: 'void' }));
    await voidInvoice('inv-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices/inv-1/void');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('Content-Type')).toBe(false);
  });

  it('listPayments hits GET /api/invoices/:id/payments', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listPayments('inv-1');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices/inv-1/payments');
  });

  it('recordPayment POSTs the amount/date to /api/invoices/:id/payments', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { payment: { id: 'pay-1' }, invoice: { id: 'inv-1', status: 'paid', balance: '0.00' } },
        201,
      ),
    );
    const input = { amount: 40, txnDate: '2026-07-04' };
    await recordPayment('inv-1', input);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/invoices/inv-1/payments');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
  });

  it('recordPayment surfaces a 422 overpayment as an ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'overpayment' }, 422));
    await expect(
      recordPayment('inv-1', { amount: 1000, txnDate: '2026-07-04' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('voidPayment POSTs to /api/payments/:id/void', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ payment: { id: 'pay-1' }, invoice: { id: 'inv-1' } }),
    );
    await voidPayment('pay-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/payments/pay-1/void');
    expect(init.method).toBe('POST');
  });

  it('listContacts filters by role and includeInactive', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listContacts({ role: 'customer', includeInactive: true });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/contacts?role=customer&includeInactive=true');
  });

  it('getContact hits GET /api/contacts/:id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'contact-1' }));
    await getContact('contact-1');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/contacts/contact-1');
  });

  it('createContact POSTs to /api/contacts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'contact-1' }, 201));
    const input = { displayName: 'Acme Co', isCustomer: true };
    await createContact(input);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/contacts');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(input));
  });

  it('archiveContact DELETEs /api/contacts/:id with no body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await archiveContact('contact-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/contacts/contact-1');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('listAccounts filters by type', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listAccounts({ type: 'asset' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/accounts?type=asset');
  });

  it('listConflicts hits GET /api/conflicts', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await listConflicts();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conflicts');
    expect(init.method).toBeUndefined();
  });

  it('resolveConflict POSTs {winner} to /api/conflicts/:linkId/resolve', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ linkId: 'link-1', state: 'synced', winner: 'local' }),
    );
    await resolveConflict('link-1', 'local');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/conflicts/link-1/resolve');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ winner: 'local' }));
  });

  it('resolveConflict surfaces a 409 invalid_state as an ApiError', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_state' }, 409));
    await expect(resolveConflict('link-1', 'qbo')).rejects.toMatchObject({ status: 409 });
  });
});
