import type { HTMLAttributes, ReactNode } from 'react';
import { color } from '../../theme.ts';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  header?: ReactNode;
  headerActions?: ReactNode;
  /** Adds the comp's clickable-card hover treatment (border + shadow lift). */
  hoverable?: boolean;
  padding?: number | string;
}

// Surface / border / radius-13 / card-shadow container per
// docs/design-system.md "Card". `header` renders a title row with a
// border-soft divider, matching every list/detail card in the comp.
//
// Background/border/shadow live in the `.ui-card` class (global.css), not
// inline, so `.ui-card--hoverable:hover` can actually override border-color
// and box-shadow (an inline style always beats a stylesheet :hover rule).
export function Card({
  header,
  headerActions,
  hoverable = false,
  padding = 18,
  className,
  style,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={`ui-card${hoverable ? ' ui-card--hoverable' : ''}${className ? ` ${className}` : ''}`}
      style={{ overflow: 'hidden', ...style }}
      {...rest}
    >
      {header ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '15px 18px',
            borderBottom: `1px solid ${color.borderSoft}`,
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>{header}</div>
          {headerActions}
        </div>
      ) : null}
      <div style={{ padding }}>{children}</div>
    </div>
  );
}
