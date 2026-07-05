import { color } from '../../theme.ts';

export interface LogoProps {
  /** Show the "Clearbook" wordmark next to the mark. Defaults to true. */
  withWordmark?: boolean;
  markSize?: number;
}

// The green rounded-square ledger mark + wordmark from the sidebar header
// in the comp (Clearbook.dc.html lines ~31-37).
export function Logo({ withWordmark = true, markSize = 30 }: LogoProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <div
        style={{
          width: markSize,
          height: markSize,
          borderRadius: 9,
          background: color.brand,
          position: 'relative',
          flex: 'none',
          boxShadow: '0 2px 5px rgba(31,122,77,.35)',
        }}
      >
        <div
          style={{ position: 'absolute', inset: 8, border: '2px solid #fff', borderRadius: 3 }}
        />
        <div
          style={{
            position: 'absolute',
            left: 8,
            right: 8,
            top: 14,
            height: 2,
            background: '#fff',
          }}
        />
      </div>
      {withWordmark ? (
        <div
          style={{ fontWeight: 700, fontSize: 16.5, letterSpacing: '-0.02em', color: color.text }}
        >
          Clearbook
        </div>
      ) : null}
    </div>
  );
}
