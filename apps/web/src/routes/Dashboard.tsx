import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge.tsx';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import { ErrorState, LoadingState } from '../components/ui/DataState.tsx';
import { Card } from '../components/ui/index.ts';
import type { CurrentUser, Invoice, InvoiceStatus, SyncState } from '../lib/api.ts';
import { listInvoices } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';
import { color, font } from '../theme.ts';

export interface DashboardProps {
  user: CurrentUser;
}

const SYNC_ORDER: SyncState[] = ['pending', 'synced', 'conflict', 'failed'];

// A KPI tile per docs/design-system.md "Stat/KPI tile": a label row (colored
// dot + muted uppercase label) + a big mono value + an optional colored sub.
function StatTile({
  label,
  value,
  sub,
  dotColor,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  dotColor: string;
  accent?: string;
}) {
  return (
    <Card padding={16}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 10 }}>
        <span
          style={{ width: 8, height: 8, borderRadius: 999, background: dotColor, flex: 'none' }}
        />
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: color.textMuted,
          }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 23,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          color: accent ?? color.text,
        }}
      >
        {value}
      </div>
      {sub ? <div style={{ fontSize: 12, color: color.textFaint, marginTop: 4 }}>{sub}</div> : null}
    </Card>
  );
}

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
  const list = invoices ?? [];

  const outstandingCents = list
    .filter((invoice) => invoice.status === 'open' || invoice.status === 'partially_paid')
    .reduce((sum, invoice) => sum + Math.round(Number(invoice.balance) * 100), 0);

  const countsByStatus = list.reduce<Partial<Record<InvoiceStatus, number>>>((acc, invoice) => {
    acc[invoice.status] = (acc[invoice.status] ?? 0) + 1;
    return acc;
  }, {});

  // Real sync-health from each invoice's syncState. In Phase 1 every invoice
  // reads `pending` (nothing syncs yet), so conflict/failed come out 0 from
  // the data itself - not hardcoded.
  const syncCounts = list.reduce<Record<SyncState, number>>(
    (acc, invoice) => {
      acc[invoice.syncState] += 1;
      return acc;
    },
    { pending: 0, synced: 0, conflict: 0, failed: 0 },
  );

  const openCount = countsByStatus.open ?? 0;
  const partialCount = countsByStatus.partially_paid ?? 0;
  const paidCount = countsByStatus.paid ?? 0;
  const unpaidCount = openCount + partialCount;
  const recent = list.slice(0, 5);

  const greetingName = user.email.split('@')[0];

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 30px 60px' }}>
      <div style={{ marginBottom: 22 }}>
        <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', color: color.text }}>
          Welcome back, {greetingName}
        </div>
        <div style={{ fontSize: 13, color: color.textMuted, marginTop: 3 }}>
          {user.email} · signed in as {user.role}
        </div>
      </div>

      {invoices === null ? (
        <LoadingState label="Loading overview…" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {loadFailed ? <ErrorState>Could not load the invoice overview.</ErrorState> : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: 14,
            }}
          >
            <StatTile
              label="Outstanding A/R"
              value={formatMoney(outstandingCents / 100)}
              sub={`${unpaidCount} unpaid ${unpaidCount === 1 ? 'invoice' : 'invoices'}`}
              dotColor={color.brand}
              accent={color.brandStrong}
            />
            <StatTile
              label="Open"
              value={String(openCount)}
              sub="awaiting payment"
              dotColor={color.brand}
            />
            <StatTile
              label="Partially paid"
              value={String(partialCount)}
              sub="in progress"
              dotColor={color.statusWarnText}
            />
            <StatTile
              label="Paid"
              value={String(paidCount)}
              sub="settled"
              dotColor={color.statusSuccessText}
            />
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)',
              gap: 18,
              alignItems: 'start',
            }}
          >
            <Card
              padding={0}
              header="Recent invoices"
              headerActions={
                <Link
                  to="/invoices"
                  style={{
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: color.brand,
                    textDecoration: 'none',
                  }}
                >
                  View all
                </Link>
              }
            >
              {recent.length === 0 ? (
                <div style={{ padding: '38px 20px', textAlign: 'center', color: color.textFaint }}>
                  <div style={{ fontSize: 13.5, marginBottom: 10 }}>No invoices yet.</div>
                  <Link
                    to="/invoices/new"
                    style={{ fontSize: 13, fontWeight: 600, color: color.brand }}
                  >
                    Create your first invoice
                  </Link>
                </div>
              ) : (
                <div>
                  {recent.map((invoice, index) => (
                    <Link
                      key={invoice.id}
                      to={`/invoices/${invoice.id}`}
                      className="ui-table-row"
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr auto auto',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 18px',
                        textDecoration: 'none',
                        color: color.text,
                        borderTop: index === 0 ? undefined : `1px solid ${color.borderSoft}`,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: font.mono,
                          fontSize: 13,
                          fontWeight: 500,
                          color: color.text2,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {invoice.docNumber ?? invoice.id.slice(0, 8)}
                      </span>
                      <span
                        style={{
                          fontFamily: font.mono,
                          fontSize: 13,
                          fontVariantNumeric: 'tabular-nums',
                          color: color.text,
                        }}
                      >
                        {formatMoney(invoice.total)}
                      </span>
                      <InvoiceStatusBadge status={invoice.status} />
                    </Link>
                  ))}
                </div>
              )}
            </Card>

            <Card padding={0} header="Sync health">
              <div
                style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}
              >
                {SYNC_ORDER.map((state) => (
                  <div
                    key={state}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <SyncStatusBadge state={state} />
                    <span
                      style={{
                        fontFamily: font.mono,
                        fontSize: 14,
                        fontWeight: 600,
                        color: color.text,
                      }}
                    >
                      {syncCounts[state]}
                    </span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  borderTop: `1px solid ${color.borderSoft}`,
                  padding: '12px 18px',
                  fontSize: 12,
                  color: color.textFaint,
                  lineHeight: 1.5,
                }}
              >
                {syncCounts.synced > 0
                  ? 'Syncing invoices with QuickBooks Online.'
                  : 'Connect QuickBooks to start syncing your invoices.'}{' '}
                <Link to="/integrations" style={{ color: color.brand, fontWeight: 600 }}>
                  Integrations
                </Link>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
