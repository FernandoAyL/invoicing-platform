import type { CSSProperties, ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { color, font, radius, shadow } from '../../theme.ts';
import { Logo } from '../ui/Logo.tsx';

// Link-styled-as-button for marketing CTAs. Navigation is a link (not a
// <button> with an onClick navigate), so it reuses the shared `.ui-btn`
// classes from global.css - which own the resting background + :hover - and
// the same metrics as the Button primitive, rather than re-implementing a
// second button look. (The Button primitive itself renders a real <button>,
// wrong element for a route change.)
const CTA_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  height: 40,
  padding: '0 18px',
  borderRadius: radius.control,
  fontSize: 13.5,
  fontWeight: 600,
  fontFamily: font.sans,
  textDecoration: 'none',
  whiteSpace: 'nowrap',
};

export function CtaLink({
  to,
  variant = 'primary',
  children,
}: {
  to: string;
  variant?: 'primary' | 'secondary';
  children: ReactNode;
}) {
  const variantStyle: CSSProperties =
    variant === 'primary'
      ? { color: '#ffffff', boxShadow: shadow.buttonPrimary }
      : { color: color.text, border: `1px solid ${color.borderInput}` };
  return (
    <Link to={to} className={`ui-btn ui-btn-${variant}`} style={{ ...CTA_BASE, ...variantStyle }}>
      {children}
    </Link>
  );
}

// Section wrapper the marketing pages compose - centered content column on the
// app canvas, consistent with the page containers in the comp (max-width
// ~1080px). Kept network-free so the SSG prerender (/, /products, /pricing)
// stays static.
export function MarketingSection({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '52px 30px 72px' }}>{children}</div>
  );
}

// Restyled public chrome (top nav + footer) wrapping the marketing routes.
// Replaces the plain <header><nav> that App.tsx used to inline.
export function PublicLayout() {
  const navLink: CSSProperties = {
    color: color.textMuted,
    textDecoration: 'none',
    fontSize: 13.5,
    fontWeight: 500,
  };
  return (
    <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          height: 62,
          background: color.surface,
          borderBottom: `1px solid ${color.border}`,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <nav
          style={{
            maxWidth: 1040,
            height: '100%',
            margin: '0 auto',
            padding: '0 30px',
            display: 'flex',
            alignItems: 'center',
            gap: 24,
          }}
        >
          <Link to="/" style={{ textDecoration: 'none' }} aria-label="Clearbook home">
            <Logo />
          </Link>
          <div style={{ flex: 1 }} />
          <Link to="/products" style={navLink}>
            Products
          </Link>
          <Link to="/pricing" style={navLink}>
            Pricing
          </Link>
          <CtaLink to="/login">Sign in</CtaLink>
        </nav>
      </header>
      <main style={{ flex: 1 }}>
        <Outlet />
      </main>
      <footer
        style={{
          borderTop: `1px solid ${color.border}`,
          background: color.surface,
        }}
      >
        <div
          style={{
            maxWidth: 1040,
            margin: '0 auto',
            padding: '20px 30px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
            fontSize: 12.5,
            color: color.textFaint,
          }}
        >
          <span>© {new Date().getFullYear()} Clearbook</span>
          <div style={{ flex: 1 }} />
          <Link to="/products" style={{ ...navLink, fontSize: 12.5 }}>
            Products
          </Link>
          <Link to="/pricing" style={{ ...navLink, fontSize: 12.5 }}>
            Pricing
          </Link>
        </div>
      </footer>
    </div>
  );
}
