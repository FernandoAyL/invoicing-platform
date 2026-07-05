import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listContacts, listInvoices } from '../lib/api.ts';
import Invoices from './Invoices.tsx';

vi.mock('../lib/api.ts', () => ({
  listInvoices: vi.fn(),
  listContacts: vi.fn(),
}));

function mkInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    type: 'customer_invoice' as const,
    status: 'open' as const,
    contactId: 'contact-1',
    docNumber: null,
    txnDate: '2026-07-04',
    dueDate: null,
    currency: 'USD',
    memo: null,
    subtotal: '100.00',
    total: '100.00',
    balance: '100.00',
    version: 0,
    syncState: 'pending' as const,
    lines: [],
    ...overrides,
  };
}

describe('Invoices list', () => {
  beforeEach(() => {
    vi.mocked(listInvoices).mockReset();
    vi.mocked(listContacts).mockReset();
  });

  it('renders a row per invoice with customer name, amounts, and badges', async () => {
    vi.mocked(listInvoices).mockResolvedValue([
      mkInvoice({ id: 'inv-1', total: '100.00', balance: '60.00', status: 'partially_paid' }),
    ]);
    vi.mocked(listContacts).mockResolvedValue([
      {
        id: 'contact-1',
        displayName: 'Acme Co',
        email: null,
        phone: null,
        isCustomer: true,
        isVendor: false,
        isEmployee: false,
        isActive: true,
      },
    ]);

    render(
      <MemoryRouter>
        <Invoices />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Acme Co')).toBeInTheDocument();
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.getByText('$60.00')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-status-badge')).toHaveTextContent('Partially paid');
    expect(screen.getByTestId('sync-status-badge')).toHaveTextContent('Not synced');
  });

  it('shows an empty state with no invoices', async () => {
    vi.mocked(listInvoices).mockResolvedValue([]);
    vi.mocked(listContacts).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Invoices />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/no invoices yet/i)).toBeInTheDocument();
  });

  it('shows an error state when the list fails to load', async () => {
    vi.mocked(listInvoices).mockRejectedValue(new Error('boom'));
    vi.mocked(listContacts).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Invoices />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load invoices/i);
  });
});
