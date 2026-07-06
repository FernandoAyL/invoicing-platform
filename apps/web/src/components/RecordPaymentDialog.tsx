import { type FormEvent, useEffect, useState } from 'react';
import type { Account } from '../lib/api.ts';
import { ApiError, listAccounts, recordPayment } from '../lib/api.ts';
import { color, radius, shadow } from '../theme.ts';
import { Button, Input, Select } from './ui/index.ts';

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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(20,35,28,.28)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Record payment"
        style={{
          width: '100%',
          maxWidth: 420,
          background: color.surface,
          borderRadius: radius.card,
          boxShadow: shadow.elevated,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: `1px solid ${color.borderSoft}`,
            fontSize: 15,
            fontWeight: 600,
            color: color.text,
          }}
        >
          Record payment
        </div>
        <form onSubmit={handleSubmit} style={{ padding: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Input
              label="Amount"
              id="payment-amount"
              type="number"
              step="0.01"
              min="0.01"
              mono
              required
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Input
              label="Date"
              id="payment-date"
              type="date"
              required
              value={txnDate}
              onChange={(event) => setTxnDate(event.target.value)}
            />
            <Select
              label="Deposit to"
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
            </Select>
            <Input
              label="Memo"
              id="payment-memo"
              type="text"
              value={memo}
              onChange={(event) => setMemo(event.target.value)}
            />
            {error ? (
              <div
                role="alert"
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: color.statusDangerTextStrong,
                  background: color.statusDangerBg,
                  border: `1px solid ${color.statusDangerBorder}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                }}
              >
                {error}
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Recording...' : 'Record payment'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
