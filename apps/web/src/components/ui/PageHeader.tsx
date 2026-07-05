import type { ReactNode } from 'react';
import { color } from '../../theme.ts';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

// Page title (20-22px/700) + muted subtitle + trailing actions slot, the
// pattern repeated at the top of Customers / Create-Invoice / etc. in the comp.
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', color: color.text }}>
          {title}
        </div>
        {subtitle ? (
          <div style={{ fontSize: 13, color: color.textMuted, marginTop: 3 }}>{subtitle}</div>
        ) : null}
      </div>
      <div style={{ flex: 1 }} />
      {actions ? <div style={{ display: 'flex', gap: 9 }}>{actions}</div> : null}
    </div>
  );
}
