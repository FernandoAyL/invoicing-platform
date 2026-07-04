import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createContact, createInvoice, listContacts } from '../lib/api.ts';
import InvoiceNew from './InvoiceNew.tsx';

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
    listContacts: vi.fn(),
    createContact: vi.fn(),
    createInvoice: vi.fn(),
  };
});

const CUSTOMER = {
  id: 'contact-1',
  displayName: 'Acme Co',
  email: null,
  phone: null,
  isCustomer: true,
  isVendor: false,
  isEmployee: false,
  isActive: true,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <InvoiceNew />
    </MemoryRouter>,
  );
}

describe('InvoiceNew', () => {
  beforeEach(() => {
    vi.mocked(listContacts).mockReset();
    vi.mocked(createContact).mockReset();
    vi.mocked(createInvoice).mockReset();
  });

  it('prompts to add a customer when there are none yet', async () => {
    vi.mocked(listContacts).mockResolvedValue([]);

    renderPage();

    expect(await screen.findByText(/don't have any customers yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create invoice/i })).toBeDisabled();
  });

  it('validates a zero quantity line before submitting', async () => {
    vi.mocked(listContacts).mockResolvedValue([CUSTOMER]);
    const user = userEvent.setup();

    renderPage();
    await screen.findByRole('option', { name: 'Acme Co' });

    const qtyInput = screen.getByLabelText(/line 1 quantity/i);
    await user.clear(qtyInput);
    await user.type(qtyInput, '0');
    await user.type(screen.getByLabelText(/line 1 unit price/i), '10');

    await user.click(screen.getByRole('button', { name: /create invoice/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/quantity must be greater than 0/i);
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it('submits a valid invoice and navigates to its detail page', async () => {
    vi.mocked(listContacts).mockResolvedValue([CUSTOMER]);
    vi.mocked(createInvoice).mockResolvedValue({
      id: 'inv-new',
      type: 'customer_invoice',
      status: 'open',
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
      syncState: 'pending',
      lines: [],
    });
    const user = userEvent.setup();

    renderPage();
    await screen.findByRole('option', { name: 'Acme Co' });

    await user.type(screen.getByLabelText(/line 1 unit price/i), '100');
    await user.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => expect(createInvoice).toHaveBeenCalledTimes(1));
    const [input] = vi.mocked(createInvoice).mock.calls[0];
    expect(input.contactId).toBe('contact-1');
    expect(input.lines).toEqual([{ description: undefined, quantity: 1, unitPrice: 100 }]);
  });

  it('surfaces a 422 error from the server inline', async () => {
    const { ApiError } = await import('../lib/api.ts');
    vi.mocked(listContacts).mockResolvedValue([CUSTOMER]);
    vi.mocked(createInvoice).mockRejectedValue(
      new ApiError(422, { error: 'invalid_contact', message: 'contact is not a customer' }),
    );
    const user = userEvent.setup();

    renderPage();
    await screen.findByRole('option', { name: 'Acme Co' });
    await user.type(screen.getByLabelText(/line 1 unit price/i), '10');
    await user.click(screen.getByRole('button', { name: /create invoice/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/contact is not a customer/i);
  });
});
