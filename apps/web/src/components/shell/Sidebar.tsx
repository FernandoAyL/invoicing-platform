import { type CSSProperties, type ReactElement, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CurrentUser } from '../../lib/api.ts';
import { listInvoices, logout } from '../../lib/api.ts';
import { color, font, spacing } from '../../theme.ts';
import { Logo } from '../ui/Logo.tsx';
import {
  CustomersIcon,
  DashboardIcon,
  IntegrationsIcon,
  InvoicesIcon,
  ReportsIcon,
  VendorBillsIcon,
} from './icons.tsx';

export interface SidebarProps {
  user: CurrentUser;
}

interface NavItem {
  to: string;
  label: string;
  icon: (props: { style?: CSSProperties }) => ReactElement;
}

const MENU_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { to: '/invoices', label: 'Invoices', icon: InvoicesIcon },
  { to: '/customers', label: 'Customers', icon: CustomersIcon },
  { to: '/integrations', label: 'Integrations', icon: IntegrationsIcon },
];

const COMING_SOON_ITEMS: Array<{ label: string; icon: NavItem['icon'] }> = [
  { label: 'Reports', icon: ReportsIcon },
  { label: 'Vendor bills', icon: VendorBillsIcon },
];

function initialsFor(user: CurrentUser): string {
  const local = user.email.split('@')[0] ?? '';
  return (local.slice(0, 2) || '??').toUpperCase();
}

function roleLabel(role: CurrentUser['role']): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function Sidebar({ user }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [invoiceCount, setInvoiceCount] = useState<number | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Decorative count chip only - if it fails to load we just hide it,
    // no need for a loading/error state in the nav rail.
    listInvoices()
      .then((invoices) => {
        if (!cancelled) setInvoiceCount(invoices.length);
      })
      .catch(() => {
        if (!cancelled) setInvoiceCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <aside
      style={{
        width: spacing.sidebarWidth,
        flex: 'none',
        background: color.surface,
        borderRight: `1px solid ${color.border}`,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      <div style={{ padding: '20px 20px 16px' }}>
        <Logo />
      </div>

      <nav style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.09em',
            color: color.textFaintAlt,
            padding: '12px 12px 6px',
          }}
        >
          MENU
        </div>
        {MENU_ITEMS.map((item) => {
          const active = location.pathname.startsWith(item.to);
          const Icon = item.icon;
          return (
            <button
              key={item.to}
              type="button"
              className="ui-nav-item"
              onClick={() => navigate(item.to)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                width: '100%',
                textAlign: 'left',
                border: 'none',
                borderRadius: 9,
                padding: '9px 12px',
                fontSize: 13.5,
                fontWeight: active ? 600 : 500,
                fontFamily: font.sans,
                cursor: 'pointer',
                // Only set `background` inline for the active (brand-tint)
                // case; leave it unset otherwise so the `.ui-nav-item`
                // class's resting `transparent` + `:hover` rule can apply
                // (an inline value would always beat the CSS :hover rule).
                background: active ? color.brandTint : undefined,
                color: active ? color.brand : color.text2,
              }}
            >
              <Icon />
              {item.label}
              {item.to === '/invoices' && invoiceCount !== null ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontFamily: font.mono,
                    fontSize: 11,
                    fontWeight: 600,
                    background: active ? '#ffffff' : color.canvas,
                    color: active ? color.brand : color.textMuted,
                    borderRadius: 999,
                    padding: '1px 7px',
                  }}
                >
                  {invoiceCount}
                </span>
              ) : null}
              {/* Integrations "needs attention" dot: no alert source exists in
                  Phase 1 (nothing syncs yet), so this is never rendered - the
                  slot is here so wiring a real alert count later is a one-line change. */}
            </button>
          );
        })}

        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.09em',
            color: color.textFaintAlt,
            padding: '18px 12px 6px',
          }}
        >
          COMING SOON
        </div>
        {COMING_SOON_ITEMS.map(({ label, icon: Icon }) => (
          <div
            key={label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 11,
              padding: '9px 12px',
              borderRadius: 9,
              color: color.textDisabled,
              fontSize: 13.5,
              fontWeight: 500,
              cursor: 'default',
            }}
          >
            <Icon />
            {label}
          </div>
        ))}
      </nav>

      <div style={{ marginTop: 'auto', padding: 14, borderTop: `1px solid ${color.borderSoft}` }}>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 8, borderRadius: 10 }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: color.brandTint,
              color: color.brand,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              fontSize: 13,
              flex: 'none',
            }}
          >
            {initialsFor(user)}
          </div>
          <div style={{ minWidth: 0, lineHeight: 1.25, flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {user.email}
            </div>
            <div style={{ fontSize: 11.5, color: color.textFaint }}>{roleLabel(user.role)}</div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            title="Log out"
            // `ui-btn` (base, for the shared `:disabled` dimming) + `ui-btn-ghost`
            // (owns resting `background:transparent` + its `:hover` rule).
            // `background` is deliberately left out of the inline style below -
            // an inline value would always beat the class's `:hover` rule, the
            // same bug fixed on Button.tsx/Card.tsx/Input.tsx during 10012.
            className="ui-btn ui-btn-ghost"
            style={{
              border: 'none',
              color: color.textMuted,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: 'pointer',
              borderRadius: 7,
              padding: '4px 6px',
              flex: 'none',
            }}
          >
            {loggingOut ? '…' : 'Log out'}
          </button>
        </div>
      </div>
    </aside>
  );
}
