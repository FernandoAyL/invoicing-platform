import type { ReactNode } from 'react';
import { formatMoney } from '../lib/money.ts';
import { color, font } from '../theme.ts';
import { Card } from './ui/index.ts';

// The sticky right-hand Summary panel on the create/edit invoice screens
// (docs/design-system.md 10015: "sticky Summary panel with subtotal/total").
// There's no tax/discount in the Phase-1 create flow, so subtotal === total;
// both are shown to match the comp. The submit button + any inline error are
// passed as children/`error` so each page keeps its own label + disabled logic.
export function InvoiceSummary({
  total,
  error,
  children,
}: {
  total: number;
  error?: string | null;
  children: ReactNode;
}) {
  const row = (label: string, value: string, strong = false) => (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{ fontSize: strong ? 13.5 : 13, color: strong ? color.text : color.textMuted }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: font.mono,
          fontSize: strong ? 17 : 13,
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          color: color.text,
        }}
      >
        {value}
      </span>
    </div>
  );

  return (
    <div style={{ position: 'sticky', top: 20 }}>
      <Card header="Summary" padding={18}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {row('Subtotal', formatMoney(total))}
          <div style={{ height: 1, background: color.borderSoft }} />
          {row('Total', formatMoney(total), true)}
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
          {children}
        </div>
      </Card>
    </div>
  );
}
