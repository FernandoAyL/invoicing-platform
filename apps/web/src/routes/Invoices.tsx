import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge.tsx';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import { Card, EmptyState, ErrorState, LoadingState } from '../components/ui/index.ts';
import type { Contact, Invoice, InvoiceStatus } from '../lib/api.ts';
import { listContacts, listInvoices } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';
import { color, font } from '../theme.ts';

type LoadState = 'loading' | 'loaded' | 'error';
type Filter = 'all' | InvoiceStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'partially_paid', label: 'Partially paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
];

// Number / Customer / Date / Total / Balance / Status / Sync / chevron.
const GRID_COLUMNS = '1.1fr 1.6fr 1fr 1fr 1fr auto auto 16px';

export default function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [contactsById, setContactsById] = useState<Map<string, Contact>>(new Map());
  const [state, setState] = useState<LoadState>('loading');
  const [filter, setFilter] = useState<Filter>('all');

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

  const counts = useMemo(() => {
    const acc: Record<Filter, number> = {
      all: invoices.length,
      draft: 0,
      open: 0,
      partially_paid: 0,
      paid: 0,
      void: 0,
    };
    for (const invoice of invoices) acc[invoice.status] += 1;
    return acc;
  }, [invoices]);

  const visible = filter === 'all' ? invoices : invoices.filter((i) => i.status === filter);

  const headerCell = (text: string, align: 'left' | 'right' = 'left') => (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: color.textFaint,
        textAlign: align,
      }}
    >
      {text}
    </div>
  );

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 30px 60px' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {FILTERS.map((tab) => {
          const active = filter === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setFilter(tab.key)}
              className="ui-nav-item"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                height: 32,
                padding: '0 12px',
                borderRadius: 8,
                border: `1px solid ${active ? color.brand : color.border}`,
                background: active ? color.brandTint : color.surface,
                color: active ? color.brand : color.textMuted,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {tab.label}
              <span
                style={{
                  fontFamily: font.mono,
                  fontSize: 11,
                  color: active ? color.brand : color.textFaint,
                }}
              >
                {counts[tab.key]}
              </span>
            </button>
          );
        })}
      </div>

      {state === 'loading' ? <LoadingState label="Loading invoices…" /> : null}
      {state === 'error' ? <ErrorState>Could not load invoices.</ErrorState> : null}

      {state === 'loaded' && invoices.length === 0 ? (
        <EmptyState>
          <div style={{ marginBottom: 10 }}>
            No invoices yet. Create your first one to get started.
          </div>
          <Link to="/invoices/new" style={{ fontWeight: 600, color: color.brand }}>
            Create your first invoice
          </Link>
        </EmptyState>
      ) : null}

      {state === 'loaded' && invoices.length > 0 ? (
        <Card padding={0}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: GRID_COLUMNS,
              gap: 14,
              alignItems: 'center',
              padding: '11px 18px',
              background: color.surfaceMuted,
              borderBottom: `1px solid ${color.borderSoft}`,
            }}
          >
            {headerCell('Number')}
            {headerCell('Customer')}
            {headerCell('Date')}
            {headerCell('Total', 'right')}
            {headerCell('Balance', 'right')}
            {headerCell('Status')}
            {headerCell('Sync')}
            <div />
          </div>

          {visible.length === 0 ? (
            <div style={{ padding: '38px 18px', textAlign: 'center', color: color.textFaint }}>
              No{' '}
              {filter === 'all'
                ? ''
                : `${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} `}
              invoices.
            </div>
          ) : (
            visible.map((invoice, index) => (
              <Link
                key={invoice.id}
                to={`/invoices/${invoice.id}`}
                className="ui-table-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: 14,
                  alignItems: 'center',
                  padding: '13px 18px',
                  textDecoration: 'none',
                  color: color.text,
                  borderTop: index === 0 ? undefined : `1px solid ${color.borderSoft}`,
                }}
              >
                <span style={{ fontFamily: font.mono, fontSize: 13, color: color.text2 }}>
                  {invoice.docNumber ?? invoice.id.slice(0, 8)}
                </span>
                <span
                  style={{
                    fontSize: 13,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {invoice.contactId
                    ? (contactsById.get(invoice.contactId)?.displayName ?? '—')
                    : '—'}
                </span>
                <span style={{ fontFamily: font.mono, fontSize: 12.5, color: color.textMuted }}>
                  {invoice.txnDate}
                </span>
                <span
                  style={{
                    fontFamily: font.mono,
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'right',
                  }}
                >
                  {formatMoney(invoice.total)}
                </span>
                <span
                  style={{
                    fontFamily: font.mono,
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'right',
                    color: color.text2,
                  }}
                >
                  {formatMoney(invoice.balance)}
                </span>
                <InvoiceStatusBadge status={invoice.status} />
                <SyncStatusBadge state={invoice.syncState} />
                <span style={{ color: color.textDisabled, fontSize: 15 }}>›</span>
              </Link>
            ))
          )}
        </Card>
      ) : null}
    </div>
  );
}
