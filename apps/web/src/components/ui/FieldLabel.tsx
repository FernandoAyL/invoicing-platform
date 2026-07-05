import type { ReactNode } from 'react';
import { color } from '../../theme.ts';

// Shared "LABEL ABOVE" pattern used by Input/Select/Textarea - 11px/600
// uppercase muted text with letter-spacing, per docs/design-system.md
// Typography scale ("labels 10.5-11px/600 uppercase letter-spacing:.03-.05em").
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontSize: 11,
        fontWeight: 600,
        color: color.textMuted,
        letterSpacing: '0.03em',
        textTransform: 'uppercase',
        marginBottom: 5,
      }}
    >
      {children}
    </label>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 11.5, color: color.statusDangerTextStrong, marginTop: 4 }}>
      {children}
    </div>
  );
}
