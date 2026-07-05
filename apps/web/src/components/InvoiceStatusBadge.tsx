import type { InvoiceStatus } from '../lib/api.ts';
import { color, font, radius } from '../theme.ts';

const LABELS: Record<InvoiceStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  void: 'Void',
};

// Colors per docs/design-system.md "Status badge -> invoice status". `draft`
// isn't in that table (the Phase-1 UI never creates a draft), so it keeps a
// neutral style consistent with the rest of the palette.
const STYLES: Record<InvoiceStatus, { background: string; color: string; strike?: boolean }> = {
  draft: { background: color.canvas, color: color.textMuted },
  open: { background: color.brandTint, color: color.brand },
  partially_paid: { background: color.statusWarnBg, color: color.statusWarnText },
  paid: { background: color.statusSuccessBg, color: color.statusSuccessText },
  void: { background: color.borderSoft, color: color.textFaint, strike: true },
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
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 9px',
        borderRadius: radius.pill,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        fontFamily: font.mono,
        whiteSpace: 'nowrap',
        backgroundColor: style.background,
        color: style.color,
        textDecoration: style.strike ? 'line-through' : undefined,
      }}
    >
      {LABELS[status]}
    </span>
  );
}
