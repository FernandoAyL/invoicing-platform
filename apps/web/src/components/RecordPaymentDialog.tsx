import { type FormEvent, useEffect, useState } from 'react';
import type { Account } from '../lib/api.ts';
import { ApiError, listAccounts, recordPayment } from '../lib/api.ts';

export interface RecordPaymentDialogProps {
  invoiceId: string;
  balance: string;
  onClose: () => void;
  onRecorded: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Amount, date, optional deposit account (default Undeposited Funds - the
// server picks that when depositAccountId is omitted) and memo. Overpayment
// (422) is surfaced inline; the dialog stays open and nothing was written.
export function RecordPaymentDialog({
  invoiceId,
  balance,
  onClose,
  onRecorded,
}: RecordPaymentDialogProps) {
  const [amount, setAmount] = useState(balance);
  const [txnDate, setTxnDate] = useState(todayIso);
  const [memo, setMemo] = useState('');
  const [depositAccountId, setDepositAccountId] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listAccounts({ type: 'asset' })
      .then((result) => {
        if (!cancelled) setAccounts(result);
      })
      .catch(() => {
        // Non-fatal: leaving the picker empty just uses the server default.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }

    setSubmitting(true);
    try {
      await recordPayment(invoiceId, {
        amount: amountNumber,
        txnDate,
        memo: memo.trim() || undefined,
        depositAccountId: depositAccountId || undefined,
      });
      onRecorded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setError('This payment would exceed the invoice balance.');
      } else {
        setError('Could not record the payment. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Record payment">
      <h2>Record payment</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="payment-amount">Amount</label>
          <input
            id="payment-amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="payment-date">Date</label>
          <input
            id="payment-date"
            type="date"
            required
            value={txnDate}
            onChange={(event) => setTxnDate(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="payment-deposit-account">Deposit to</label>
          <select
            id="payment-deposit-account"
            value={depositAccountId}
            onChange={(event) => setDepositAccountId(event.target.value)}
          >
            <option value="">Undeposited Funds (default)</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="payment-memo">Memo</label>
          <input
            id="payment-memo"
            type="text"
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
          />
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Recording...' : 'Record payment'}
        </button>
        <button type="button" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
      </form>
    </div>
  );
}
