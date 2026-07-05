import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge.tsx';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import type { Contact, Invoice } from '../lib/api.ts';
import { listContacts, listInvoices } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';

type LoadState = 'loading' | 'loaded' | 'error';

export default function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [contactsById, setContactsById] = useState<Map<string, Contact>>(new Map());
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    Promise.all([listInvoices(), listContacts({ includeInactive: true })])
      .then(([invoiceResult, contactResult]) => {
        if (cancelled) return;
        setInvoices(invoiceResult);
        setContactsById(new Map(contactResult.map((c) => [c.id, c])));
        setState('loaded');
      })
      .catch(() => {
        if (!cancelled) setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section>
      <header>
        <h1>Invoices</h1>
        <Link to="/invoices/new">New invoice</Link>
      </header>

      {state === 'loading' ? <p role="status">Loading...</p> : null}
      {state === 'error' ? <p role="alert">Could not load invoices.</p> : null}

      {state === 'loaded' && invoices.length === 0 ? (
        <p>No invoices yet. Create your first one to get started.</p>
      ) : null}

      {state === 'loaded' && invoices.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Customer</th>
              <th>Date</th>
              <th>Total</th>
              <th>Balance</th>
              <th>Status</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((invoice) => (
              <tr key={invoice.id}>
                <td>
                  <Link to={`/invoices/${invoice.id}`}>
                    {invoice.docNumber ?? invoice.id.slice(0, 8)}
                  </Link>
                </td>
                <td>
                  {invoice.contactId
                    ? (contactsById.get(invoice.contactId)?.displayName ?? '—')
                    : '—'}
                </td>
                <td>{invoice.txnDate}</td>
                <td>{formatMoney(invoice.total)}</td>
                <td>{formatMoney(invoice.balance)}</td>
                <td>
                  <InvoiceStatusBadge status={invoice.status} />
                </td>
                <td>
                  <SyncStatusBadge state={invoice.syncState} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
