import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getContact, getInvoice, getInvoiceLedger, listPayments } from '../lib/api.ts';
import InvoiceDetail from './InvoiceDetail.tsx';

vi.mock('../lib/api.ts', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`API request failed with status ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    getInvoice: vi.fn(),
    getContact: vi.fn(),
    listPayments: vi.fn(),
    getInvoiceLedger: vi.fn(),
    voidInvoice: vi.fn(),
    voidPayment: vi.fn(),
  };
});

function mkInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    type: 'customer_invoice' as const,
    status: 'open' as const,
    contactId: 'contact-1',
    docNumber: 'INV-0001',
    txnDate: '2026-07-04',
    dueDate: null,
    currency: 'USD',
    memo: null,
    subtotal: '100.00',
    total: '100.00',
    balance: '100.00',
    version: 0,
    syncState: 'pending' as const,
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        itemId: null,
        accountId: 'acct-income',
        description: 'Consulting',
        quantity: '1',
        unitPrice: '100.00',
        amount: '100.00',
      },
    ],
    ...overrides,
  };
}

function mkLedger() {
  return {
    entries: [
      {
        id: 'led-1',
        accountId: 'acct-ar',
        accountName: 'Accounts Receivable',
        accountCode: null,
        accountSubtype: 'accounts_receivable',
        entryDate: '2026-07-04',
        debit: '100.00',
        credit: '0.00',
      },
      {
        id: 'led-2',
        accountId: 'acct-income',
        accountName: 'Sales Income',
        accountCode: null,
        accountSubtype: 'sales_income',
        entryDate: '2026-07-04',
        debit: '0.00',
        credit: '100.00',
      },
    ],
    totalDebit: '100.00',
    totalCredit: '100.00',
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/invoices/inv-1']}>
      <Routes>
        <Route path="/invoices/:id" element={<InvoiceDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvoiceDetail — ledger postings card', () => {
  beforeEach(() => {
    vi.mocked(getInvoice).mockReset();
    vi.mocked(getContact).mockReset();
    vi.mocked(listPayments).mockReset();
    vi.mocked(getInvoiceLedger).mockReset();
  });

  it('renders both account rows and a balanced totals row', async () => {
    vi.mocked(getInvoice).mockResolvedValue(mkInvoice());
    vi.mocked(getContact).mockResolvedValue(null as never);
    vi.mocked(listPayments).mockResolvedValue([]);
    vi.mocked(getInvoiceLedger).mockResolvedValue(mkLedger());

    renderPage();

    const heading = await screen.findByText('Ledger postings');
    expect(heading).toBeInTheDocument();
    const card = heading.closest('.ui-card');
    if (!card) throw new Error('ledger card not found');
    const ledgerCard = within(card as HTMLElement);

    expect(ledgerCard.getByText('Accounts Receivable')).toBeInTheDocument();
    expect(ledgerCard.getByText('Sales Income')).toBeInTheDocument();

    // A/R debit + income credit cells, plus both totals-row cells (all $100.00).
    expect(ledgerCard.getAllByText('$100.00')).toHaveLength(4);
    // Balanced totals row.
    expect(ledgerCard.getByText('balanced')).toBeInTheDocument();
    expect(ledgerCard.getByText('Total')).toBeInTheDocument();
  });

  it('omits the card when the ledger read fails, without affecting the rest of the page', async () => {
    vi.mocked(getInvoice).mockResolvedValue(mkInvoice());
    vi.mocked(getContact).mockResolvedValue(null as never);
    vi.mocked(listPayments).mockResolvedValue([]);
    vi.mocked(getInvoiceLedger).mockRejectedValue(new Error('boom'));

    renderPage();

    expect(await screen.findByText(/invoice inv-0001/i)).toBeInTheDocument();
    expect(screen.queryByText('Ledger postings')).not.toBeInTheDocument();
  });

  it('omits the card when the ledger has no entries', async () => {
    vi.mocked(getInvoice).mockResolvedValue(mkInvoice());
    vi.mocked(getContact).mockResolvedValue(null as never);
    vi.mocked(listPayments).mockResolvedValue([]);
    vi.mocked(getInvoiceLedger).mockResolvedValue({
      entries: [],
      totalDebit: '0.00',
      totalCredit: '0.00',
    });

    renderPage();

    expect(await screen.findByText(/invoice inv-0001/i)).toBeInTheDocument();
    expect(screen.queryByText('Ledger postings')).not.toBeInTheDocument();
  });
});
