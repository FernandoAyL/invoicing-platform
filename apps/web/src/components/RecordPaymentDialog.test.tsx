import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAccounts, recordPayment } from '../lib/api.ts';
import { RecordPaymentDialog } from './RecordPaymentDialog.tsx';

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
    listAccounts: vi.fn(),
    recordPayment: vi.fn(),
  };
});

describe('RecordPaymentDialog', () => {
  beforeEach(() => {
    vi.mocked(listAccounts)
      .mockReset()
      .mockResolvedValue([
        {
          id: 'acct-bank',
          code: '1000',
          name: 'Business Checking',
          type: 'asset',
          subtype: 'bank',
          currency: 'USD',
          isActive: true,
        },
      ]);
    vi.mocked(recordPayment).mockReset();
  });

  it('prefills the amount with the remaining balance and lists deposit accounts', async () => {
    render(
      <RecordPaymentDialog
        invoiceId="inv-1"
        balance="60.00"
        onClose={vi.fn()}
        onRecorded={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/amount/i)).toHaveValue(60);
    await waitFor(() => expect(listAccounts).toHaveBeenCalledWith({ type: 'asset' }));
    expect(await screen.findByRole('option', { name: 'Business Checking' })).toBeInTheDocument();
  });

  it('records a payment and calls onRecorded on success', async () => {
    vi.mocked(recordPayment).mockResolvedValue({
      payment: {
        id: 'pay-1',
        type: 'payment',
        status: 'paid',
        contactId: null,
        txnDate: '2026-07-04',
        memo: null,
        amount: '40.00',
        version: 0,
      },
      invoice: { id: 'inv-1', status: 'partially_paid', balance: '60.00', version: 1 },
    });
    const onRecorded = vi.fn();
    const user = userEvent.setup();

    render(
      <RecordPaymentDialog
        invoiceId="inv-1"
        balance="100.00"
        onClose={vi.fn()}
        onRecorded={onRecorded}
      />,
    );

    const amountInput = screen.getByLabelText(/amount/i);
    await user.clear(amountInput);
    await user.type(amountInput, '40');
    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(recordPayment).toHaveBeenCalledTimes(1));
    const [invoiceId, input] = vi.mocked(recordPayment).mock.calls[0];
    expect(invoiceId).toBe('inv-1');
    expect(input.amount).toBe(40);
    expect(onRecorded).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 422 overpayment inline and does not call onRecorded', async () => {
    const { ApiError } = await import('../lib/api.ts');
    vi.mocked(recordPayment).mockRejectedValue(new ApiError(422, { error: 'overpayment' }));
    const onRecorded = vi.fn();
    const user = userEvent.setup();

    render(
      <RecordPaymentDialog
        invoiceId="inv-1"
        balance="50.00"
        onClose={vi.fn()}
        onRecorded={onRecorded}
      />,
    );

    await user.click(screen.getByRole('button', { name: /record payment/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/exceed the invoice balance/i);
    expect(onRecorded).not.toHaveBeenCalled();
    // Dialog stays open/mounted with the form still present.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
