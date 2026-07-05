import { CtaLink, MarketingSection } from '../components/marketing/PublicLayout.tsx';
import { Card } from '../components/ui/index.ts';
import { color, font } from '../theme.ts';

const INCLUDED = [
  'Unlimited customer invoices',
  'Full & partial payment recording',
  'Double-entry ledger',
  'Two-way QuickBooks Online sync',
];

export default function Pricing() {
  return (
    <MarketingSection>
      <h1
        style={{
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: '-0.02em',
          color: color.text,
          margin: '0 0 10px',
        }}
      >
        Pricing
      </h1>
      <p style={{ fontSize: 15, color: color.textMuted, margin: '0 0 28px', maxWidth: 560 }}>
        Simple, transparent pricing. One plan with everything included.
      </p>

      <Card padding={0} style={{ maxWidth: 420 }}>
        <div style={{ padding: '22px 22px 18px', borderBottom: `1px solid ${color.borderSoft}` }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: color.textMuted,
              marginBottom: 10,
            }}
          >
            Standard
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span
              style={{
                fontFamily: font.mono,
                fontSize: 34,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: color.text,
              }}
            >
              $29
            </span>
            <span style={{ fontSize: 13.5, color: color.textMuted }}>/ month</span>
          </div>
        </div>
        <div style={{ padding: 22 }}>
          <ul style={{ listStyle: 'none', margin: '0 0 20px', padding: 0 }}>
            {INCLUDED.map((item) => (
              <li
                key={item}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 13.5,
                  color: color.text2,
                  padding: '7px 0',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    flex: 'none',
                    width: 16,
                    height: 16,
                    borderRadius: 999,
                    background: color.brandTint,
                    color: color.brand,
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  ✓
                </span>
                {item}
              </li>
            ))}
          </ul>
          <CtaLink to="/login">Get started</CtaLink>
        </div>
      </Card>
    </MarketingSection>
  );
}
