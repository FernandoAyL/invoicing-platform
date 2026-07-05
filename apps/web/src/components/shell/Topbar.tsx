import { useNavigate } from 'react-router-dom';
import { color, font, spacing } from '../../theme.ts';
import { Button } from '../ui/Button.tsx';
import { IntegrationsIcon, PlusIcon, SearchIcon } from './icons.tsx';

export interface TopbarProps {
  pageTitle: string;
}

// 60px white topbar: page title, search input, sync-connection chip, primary
// "New invoice" CTA - docs/design-system.md "App shell" + the comp's <header>.
//
// Phase-1 scope guard: the comp's sync chip shows "Connected"; there is no
// QuickBooks connection yet (that's Phase 2), so this renders a neutral,
// non-fabricated "Not connected" state and links to the Integrations
// placeholder rather than a real connection flow.
export function Topbar({ pageTitle }: TopbarProps) {
  const navigate = useNavigate();

  return (
    <header
      style={{
        height: spacing.topbarHeight,
        flex: 'none',
        background: color.surface,
        borderBottom: `1px solid ${color.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '0 26px',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>{pageTitle}</div>
      <div style={{ flex: 1 }} />

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <SearchIcon style={{ position: 'absolute', left: 11, pointerEvents: 'none' }} />
        {/* `ui-field` (not inline border/outline) so this gets the same
            brand focus ring as Input/Select/Textarea - an inline
            `outline:'none'` with no replacement leaves keyboard users with
            no visible focus state, which docs/design-system.md's a11y
            section explicitly requires. */}
        <input
          placeholder="Search invoices, customers…"
          className="ui-field"
          style={{
            width: 250,
            height: 38,
            borderRadius: 9,
            padding: '0 12px 0 34px',
            fontSize: 13,
            fontFamily: font.sans,
            background: color.surfaceMuted,
            color: color.text,
          }}
        />
      </div>

      <button
        type="button"
        onClick={() => navigate('/integrations')}
        title="QuickBooks connection"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          background: color.surfaceMuted,
          border: `1px solid ${color.border}`,
          borderRadius: 999,
          height: 34,
          padding: '0 12px',
          fontSize: 12,
          fontWeight: 600,
          color: color.textFaint,
          cursor: 'pointer',
        }}
      >
        <IntegrationsIcon style={{ width: 14, height: 14 }} />
        Not connected
      </button>

      <Button variant="primary" onClick={() => navigate('/invoices/new')}>
        <PlusIcon />
        New invoice
      </Button>
    </header>
  );
}
