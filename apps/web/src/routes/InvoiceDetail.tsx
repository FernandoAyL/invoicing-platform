import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge.tsx';
import { RecordPaymentDialog } from '../components/RecordPaymentDialog.tsx';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import type { Contact, Invoice, Payment } from '../lib/api.ts';
import {
  ApiError,
  getContact,
  getInvoice,
  listPayments,
  voidInvoice,
  voidPayment,
} from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';

type LoadState = 'loading' | 'loaded' | 'not-found' | 'error';

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<LoadState>('loading');
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [customer, setCustomer] = useState<Contact | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    setState('loading');
    getInvoice(id)
      .then(async (result) => {
        setInvoice(result);
        const [contactResult, paymentResult] = await Promise.all([
          result.contactId ? getContact(result.contactId).catch(() => null) : Promise.resolve(null),
          listPayments(id).catch(() => []),
        ]);
        setCustomer(contactResult);
        setPayments(paymentResult);
        setState('loaded');
      })
      .catch((err) => {
        setState(err instanceof ApiError && err.status === 404 ? 'not-found' : 'error');
      });
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleVoidInvoice() {
    if (!id) return;
    setActionError(null);
    setVoiding(true);
    try {
      await voidInvoice(id);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setActionError('This invoice can no longer be voided.');
        load();
      } else {
        setActionError('Could not void the invoice.');
      }
    } finally {
      setVoiding(false);
    }
  }

  async function handleVoidPayment(paymentId: string) {
    setActionError(null);
    try {
      await voidPayment(paymentId);
      load();
    } catch {
      setActionError('Could not void this payment.');
    }
  }

  if (state === 'loading') return <p role="status">Loading...</p>;

  if (state === 'not-found') {
    return (
      <section>
        <h1>Invoice not found</h1>
        <Link to="/invoices">Back to invoices</Link>
      </section>
    );
  }

  if (state === 'error' || !invoice) {
    return <p role="alert">Could not load this invoice.</p>;
  }

  const canEditOrVoid = invoice.status === 'open';
  const canRecordPayment = invoice.status === 'open' || invoice.status === 'partially_paid';

  return (
    <section>
      <Link to="/invoices">Back to invoices</Link>
      <h1>Invoice {invoice.docNumber ?? invoice.id.slice(0, 8)}</h1>
      <p>
        Customer: {customer?.displayName ?? '—'} · Date: {invoice.txnDate}
        {invoice.dueDate ? ` · Due: ${invoice.dueDate}` : ''}
      </p>
      <p>
        <InvoiceStatusBadge status={invoice.status} /> <SyncStatusBadge state={invoice.syncState} />
      </p>

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Qty</th>
            <th>Unit price</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id}>
              <td>{line.description ?? '—'}</td>
              <td>{line.quantity}</td>
              <td>{formatMoney(line.unitPrice)}</td>
              <td>{formatMoney(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>Total: {formatMoney(invoice.total)}</p>
      <p>Balance: {formatMoney(invoice.balance)}</p>

      {actionError ? <p role="alert">{actionError}</p> : null}

      <div>
        {canRecordPayment ? (
          <button type="button" onClick={() => setShowPaymentDialog(true)}>
            Record payment
          </button>
        ) : null}
        {canEditOrVoid ? <Link to={`/invoices/${invoice.id}/edit`}>Edit</Link> : null}
        {canEditOrVoid ? (
          <button type="button" onClick={handleVoidInvoice} disabled={voiding}>
            {voiding ? 'Voiding...' : 'Void'}
          </button>
        ) : null}
      </div>

      <h2>Payments</h2>
      {payments.length === 0 ? (
        <p>No payments recorded yet.</p>
      ) : (
        <ul>
          {payments.map((payment) => (
            <li key={payment.id}>
              {formatMoney(payment.amount)} on {payment.txnDate} ({payment.status})
              {payment.status !== 'void' ? (
                <button type="button" onClick={() => handleVoidPayment(payment.id)}>
                  Void
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {showPaymentDialog ? (
        <RecordPaymentDialog
          invoiceId={invoice.id}
          balance={invoice.balance}
          onClose={() => setShowPaymentDialog(false)}
          onRecorded={() => {
            setShowPaymentDialog(false);
            load();
          }}
        />
      ) : null}
    </section>
  );
}
