import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge.tsx';
import type { CurrentUser, Invoice, InvoiceStatus } from '../lib/api.ts';
import { listInvoices } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';

export interface DashboardProps {
  user: CurrentUser;
}

const STATUS_ORDER: InvoiceStatus[] = ['open', 'partially_paid', 'paid', 'void'];

export default function Dashboard({ user }: DashboardProps) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listInvoices()
      .then((result) => {
        if (!cancelled) setInvoices(result);
      })
      .catch(() => {
        if (!cancelled) {
          setInvoices([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase-1 overview is derived client-side from the invoice list rather
  // than a dedicated summary endpoint - the list is small enough in this
  // phase that a second round-trip/aggregation endpoint isn't warranted yet.
  const outstandingCents = (invoices ?? [])
    .filter((invoice) => invoice.status === 'open' || invoice.status === 'partially_paid')
    .reduce((sum, invoice) => sum + Math.round(Number(invoice.balance) * 100), 0);

  const countsByStatus = (invoices ?? []).reduce<Partial<Record<InvoiceStatus, number>>>(
    (acc, invoice) => {
      acc[invoice.status] = (acc[invoice.status] ?? 0) + 1;
      return acc;
    },
    {},
  );

  const recent = (invoices ?? []).slice(0, 5);

  return (
    <section>
      <h1>Dashboard</h1>
      <p>
        Welcome, {user.email} ({user.role})
      </p>

      {invoices === null ? (
        <p role="status">Loading overview...</p>
      ) : (
        <>
          {loadFailed ? <p role="alert">Could not load the invoice overview.</p> : null}

          <section>
            <h2>Outstanding</h2>
            <p>{formatMoney(outstandingCents / 100)}</p>
          </section>

          <section>
            <h2>Invoices by status</h2>
            <ul>
              {STATUS_ORDER.map((status) => (
                <li key={status}>
                  <InvoiceStatusBadge status={status} />: {countsByStatus[status] ?? 0}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Recent invoices</h2>
            {recent.length === 0 ? (
              <p>
                No invoices yet. <Link to="/invoices/new">Create your first invoice</Link>.
              </p>
            ) : (
              <ul>
                {recent.map((invoice) => (
                  <li key={invoice.id}>
                    <Link to={`/invoices/${invoice.id}`}>
                      {invoice.docNumber ?? invoice.id.slice(0, 8)}
                    </Link>{' '}
                    {formatMoney(invoice.total)} <InvoiceStatusBadge status={invoice.status} />
                  </li>
                ))}
              </ul>
            )}
            <Link to="/invoices">View all invoices</Link>
          </section>
        </>
      )}
    </section>
  );
}
