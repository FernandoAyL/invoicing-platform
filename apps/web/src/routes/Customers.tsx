import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { QboLink } from '../components/QboLink.tsx';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
} from '../components/ui/index.ts';
import type { Contact, Invoice } from '../lib/api.ts';
import { archiveContact, createContact, listContacts, listInvoices } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';
import { color, font, shadow } from '../theme.ts';

type LoadState = 'loading' | 'loaded' | 'error';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Customers grid columns: Customer / Invoices / Balance / Sync / actions.
const GRID_COLUMNS = '2fr 90px 1fr auto auto';

export default function Customers() {
  const [customers, setCustomers] = useState<Contact[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setState('loading');
    Promise.all([listContacts({ role: 'customer' }), listInvoices().catch(() => [])])
      .then(([customerResult, invoiceResult]) => {
        setCustomers(customerResult);
        setInvoices(invoiceResult);
        setState('loaded');
      })
      .catch(() => setState('error'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Per-customer invoice count + outstanding balance, aggregated from the
  // invoice list (no dedicated endpoint in Phase 1 - same approach as the
  // dashboard/invoices screens).
  const statsByCustomer = useMemo(() => {
    const map = new Map<string, { count: number; balanceCents: number }>();
    for (const invoice of invoices) {
      if (!invoice.contactId) continue;
      const current = map.get(invoice.contactId) ?? { count: 0, balanceCents: 0 };
      current.count += 1;
      current.balanceCents += Math.round(Number(invoice.balance) * 100);
      map.set(invoice.contactId, current);
    }
    return map;
  }, [invoices]);

  function openDrawer() {
    setDisplayName('');
    setEmail('');
    setPhone('');
    setError(null);
    setDrawerOpen(true);
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!displayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createContact({
        displayName: displayName.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        isCustomer: true,
      });
      setDrawerOpen(false);
      load();
    } catch {
      setError('Could not create the customer.');
    } finally {
      setCreating(false);
    }
  }

  async function handleArchive(id: string) {
    setError(null);
    try {
      await archiveContact(id);
      load();
    } catch {
      setError('Could not archive this customer.');
    }
  }

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
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 30px 60px' }}>
      <PageHeader
        title="Customers"
        actions={
          <Button variant="primary" onClick={openDrawer}>
            Add customer
          </Button>
        }
      />

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorState>{error}</ErrorState>
        </div>
      ) : null}

      {state === 'loading' ? <LoadingState label="Loading customers…" /> : null}
      {state === 'error' ? <ErrorState>Could not load customers.</ErrorState> : null}
      {state === 'loaded' && customers.length === 0 ? (
        <EmptyState>No customers yet. Add your first one to start invoicing.</EmptyState>
      ) : null}

      {state === 'loaded' && customers.length > 0 ? (
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
            {headerCell('Customer')}
            {headerCell('Invoices', 'right')}
            {headerCell('Balance', 'right')}
            {headerCell('Sync')}
            <div />
          </div>

          {customers.map((customer, index) => {
            const stats = statsByCustomer.get(customer.id);
            return (
              <div
                key={customer.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID_COLUMNS,
                  gap: 14,
                  alignItems: 'center',
                  padding: '12px 18px',
                  borderTop: index === 0 ? undefined : `1px solid ${color.borderSoft}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 11, minWidth: 0 }}>
                  <span
                    style={{
                      flex: 'none',
                      width: 32,
                      height: 32,
                      borderRadius: 999,
                      background: color.brandTint,
                      color: color.brand,
                      fontSize: 12,
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {initials(customer.displayName)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: color.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {customer.displayName}
                    </div>
                    <div style={{ fontSize: 12, color: color.textMuted }}>
                      {customer.email ?? customer.phone ?? '—'}
                    </div>
                  </div>
                </div>
                <div
                  style={{
                    fontFamily: font.mono,
                    fontSize: 13,
                    textAlign: 'right',
                    color: color.text2,
                  }}
                >
                  {stats?.count ?? 0}
                </div>
                <div
                  style={{
                    fontFamily: font.mono,
                    fontSize: 13,
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'right',
                    color: color.text,
                  }}
                >
                  {formatMoney((stats?.balanceCents ?? 0) / 100)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <SyncStatusBadge state={customer.syncState} />
                  {customer.qboUrl ? <QboLink href={customer.qboUrl} label="View" /> : null}
                </div>
                <Button
                  variant="ghost"
                  height={30}
                  onClick={() => handleArchive(customer.id)}
                  style={{ color: color.statusDangerTextStrong, fontSize: 12.5 }}
                >
                  Archive
                </Button>
              </div>
            );
          })}
        </Card>
      ) : null}

      {drawerOpen ? (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
            background: 'rgba(20,35,28,.28)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Add customer"
            style={{
              width: 'min(400px, 100%)',
              height: '100%',
              background: color.surface,
              boxShadow: shadow.drawer,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              style={{
                padding: '18px 22px',
                borderBottom: `1px solid ${color.borderSoft}`,
                fontSize: 16,
                fontWeight: 600,
                color: color.text,
              }}
            >
              Add customer
            </div>
            <form
              onSubmit={handleCreate}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 22 }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16, flex: 1 }}>
                <Input
                  label="Name"
                  id="customer-name"
                  type="text"
                  required
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <Input
                  label="Email"
                  id="customer-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <Input
                  label="Phone"
                  id="customer-phone"
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
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
              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  justifyContent: 'flex-end',
                  borderTop: `1px solid ${color.borderSoft}`,
                  paddingTop: 16,
                  marginTop: 16,
                }}
              >
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setDrawerOpen(false)}
                  disabled={creating}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={creating}>
                  {creating ? 'Adding...' : 'Add customer'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
