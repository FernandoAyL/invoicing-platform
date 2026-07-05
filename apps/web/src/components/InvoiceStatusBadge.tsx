import type { InvoiceStatus } from '../lib/api.ts';

const LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
};

const STYLES: Record<InvoiceStatus, { background: string; color: string }> = {
  draft: { background: '#e5e7eb', color: '#374151' },
  open: { background: '#dbeafe', color: '#1e40af' },
  partially_paid: { background: '#fef3c7', color: '#92400e' },
  paid: { background: '#dcfce7', color: '#166534' },
  void: { background: '#f3f4f6', color: '#6b7280' },
};

export interface InvoiceStatusBadgeProps {
  status: InvoiceStatus;
}

export function InvoiceStatusBadge({ status }: InvoiceStatusBadgeProps) {
  const style = STYLES[status];
  return (
    <span
      data-testid="invoice-status-badge"
      data-status={status}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: style.background,
        color: style.color,
      }}
    >
      {LABELS[status]}
    </span>
  );
}
