import type { ReactNode } from 'react';
import { color } from '../../theme.ts';

// Loading/empty/error helpers matching the comp's centered-muted-text-in-a-card
// empty state (~60px padding). Screens keep their own data-fetching logic and
// existing `role="status"`/`role="alert"` semantics - these only standardize
// the look, not the fetch pattern.

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: 13,
        padding: 60,
        textAlign: 'center',
        color: color.textFaint,
        fontSize: 13.5,
      }}
    >
      {label}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: color.surface,
        border: `1px solid ${color.border}`,
        borderRadius: 13,
        padding: 60,
        textAlign: 'center',
        color: color.textFaint,
        fontSize: 13.5,
      }}
    >
      {children}
    </div>
  );
}

export function ErrorState({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        background: color.statusDangerBg,
        border: `1px solid ${color.statusDangerBorder}`,
        borderRadius: 13,
        padding: 20,
        color: color.statusDangerTextStrong,
        fontSize: 13.5,
        fontWeight: 500,
      }}
    >
      {children}
    </div>
  );
}
