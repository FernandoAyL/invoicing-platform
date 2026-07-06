import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge.tsx';
import { RecordPaymentDialog } from '../components/RecordPaymentDialog.tsx';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import { Button, Card, EmptyState, ErrorState, LoadingState } from '../components/ui/index.ts';
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
import { color, font } from '../theme.ts';

type LoadState = 'loading' | 'loaded' | 'not-found' | 'error';

function PaymentStatusPill({ status }: { status: string }) {
  const isVoid = status === 'void';
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
        textTransform: 'capitalize',
        background: isVoid ? color.borderSoft : color.statusSuccessBg,
        color: isVoid ? color.textFaint : color.statusSuccessText,
        textDecoration: isVoid ? 'line-through' : undefined,
      }}
    >
      {status}
    </span>
  );
}

export default function InvoiceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
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

  const backLink = (
    <Link
      to="/invoices"
      style={{
        display: 'inline-block',
        marginBottom: 14,
        fontSize: 13,
        fontWeight: 600,
        color: color.brand,
        textDecoration: 'none',
      }}
    >
      ← Back to invoices
    </Link>
  );
  const page = (children: ReactNode) => (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '24px 30px 60px' }}>{children}</div>
  );

  if (state === 'loading') return page(<LoadingState label="Loading invoice…" />);
  if (state === 'not-found')
    return page(
      <>
        {backLink}
        <EmptyState>Invoice not found.</EmptyState>
      </>,
    );
  if (state === 'error' || !invoice)
    return page(
      <>
        {backLink}
        <ErrorState>Could not load this invoice.</ErrorState>
      </>,
    );

  const canEditOrVoid = invoice.status === 'open';
  const canRecordPayment = invoice.status === 'open' || invoice.status === 'partially_paid';
  const paidAmount = Number(invoice.total) - Number(invoice.balance);

  const totalRow = (label: string, value: string, strong = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ fontSize: strong ? 14 : 13, color: strong ? color.text : color.textMuted }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: font.mono,
          fontSize: strong ? 16 : 13,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: color.text,
        }}
      >
        {value}
      </span>
    </div>
  );

  return page(
    <>
      {backLink}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: color.text }}
            >
              Invoice {invoice.docNumber ?? invoice.id.slice(0, 8)}
            </span>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <div style={{ fontSize: 13, color: color.textMuted, marginTop: 4 }}>
            {invoice.txnDate}
            {invoice.dueDate ? ` · Due ${invoice.dueDate}` : ''}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 9 }}>
          {canRecordPayment ? (
            <Button variant="primary" onClick={() => setShowPaymentDialog(true)}>
              Record payment
            </Button>
          ) : null}
          {canEditOrVoid ? (
            <Button variant="secondary" onClick={() => navigate(`/invoices/${invoice.id}/edit`)}>
              Edit
            </Button>
          ) : null}
          {canEditOrVoid ? (
            <Button variant="danger" onClick={handleVoidInvoice} disabled={voiding}>
              {voiding ? 'Voiding...' : 'Void'}
            </Button>
          ) : null}
        </div>
      </div>

      {actionError ? (
        <div style={{ marginBottom: 18 }}>
          <ErrorState>{actionError}</ErrorState>
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 280px)',
          gap: 18,
          alignItems: 'start',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <Card padding={22}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: color.textFaint,
                marginBottom: 6,
              }}
            >
              Bill to
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: color.text }}>
              {customer?.displayName ?? '—'}
            </div>
            {customer?.email ? (
              <div style={{ fontSize: 13, color: color.textMuted, marginTop: 2 }}>
                {customer.email}
              </div>
            ) : null}

            <div style={{ height: 1, background: color.borderSoft, margin: '18px 0' }} />

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 70px 110px 110px',
                gap: 12,
                padding: '0 0 8px',
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                color: color.textFaint,
              }}
            >
              <div>Description</div>
              <div style={{ textAlign: 'right' }}>Qty</div>
              <div style={{ textAlign: 'right' }}>Unit price</div>
              <div style={{ textAlign: 'right' }}>Amount</div>
            </div>
            {invoice.lines.map((line, index) => (
              <div
                key={line.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 70px 110px 110px',
                  gap: 12,
                  padding: '10px 0',
                  fontSize: 13,
                  borderTop: index === 0 ? undefined : `1px solid ${color.borderSoft}`,
                }}
              >
                <div style={{ color: color.text }}>{line.description ?? '—'}</div>
                <div style={{ fontFamily: font.mono, textAlign: 'right', color: color.text2 }}>
                  {line.quantity}
                </div>
                <div
                  style={{
                    fontFamily: font.mono,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: color.text2,
                  }}
                >
                  {formatMoney(line.unitPrice)}
                </div>
                <div
                  style={{
                    fontFamily: font.mono,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: color.text,
                  }}
                >
                  {formatMoney(line.amount)}
                </div>
              </div>
            ))}

            <div style={{ height: 1, background: color.borderSoft, margin: '10px 0 16px' }} />

            <div
              style={{
                marginLeft: 'auto',
                width: 'min(280px, 100%)',
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
              }}
            >
              {totalRow('Subtotal', formatMoney(invoice.subtotal))}
              {totalRow('Total', formatMoney(invoice.total))}
              {totalRow('Paid', formatMoney(paidAmount))}
              <div style={{ height: 1, background: color.borderSoft }} />
              {totalRow('Balance', formatMoney(invoice.balance), true)}
            </div>
          </Card>

          <Card padding={0} header="Payments">
            {payments.length === 0 ? (
              <div
                style={{
                  padding: '28px 18px',
                  textAlign: 'center',
                  color: color.textFaint,
                  fontSize: 13.5,
                }}
              >
                No payments recorded yet.
              </div>
            ) : (
              <div>
                {payments.map((payment, index) => (
                  <div
                    key={payment.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '12px 18px',
                      borderTop: index === 0 ? undefined : `1px solid ${color.borderSoft}`,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: font.mono,
                        fontSize: 13.5,
                        fontWeight: 600,
                        fontVariantNumeric: 'tabular-nums',
                        color: color.text,
                      }}
                    >
                      {formatMoney(payment.amount)}
                    </span>
                    <span style={{ fontFamily: font.mono, fontSize: 12.5, color: color.textMuted }}>
                      {payment.txnDate}
                    </span>
                    <PaymentStatusPill status={payment.status} />
                    <div style={{ flex: 1 }} />
                    {payment.status !== 'void' ? (
                      <Button
                        variant="ghost"
                        height={30}
                        onClick={() => handleVoidPayment(payment.id)}
                        style={{ color: color.statusDangerTextStrong, fontSize: 12.5 }}
                      >
                        Void
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <Card padding={0} header="Sync status">
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SyncStatusBadge state={invoice.syncState} />
            <div style={{ fontSize: 12.5, color: color.textFaint, lineHeight: 1.5 }}>
              Not yet synced to QuickBooks — two-way sync starts in a later phase.{' '}
              <Link to="/integrations" style={{ color: color.brand, fontWeight: 600 }}>
                Integrations
              </Link>
            </div>
          </div>
        </Card>
      </div>

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
    </>,
  );
}
