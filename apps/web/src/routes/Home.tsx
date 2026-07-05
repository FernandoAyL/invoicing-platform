import { CtaLink, MarketingSection } from '../components/marketing/PublicLayout.tsx';
import { Card } from '../components/ui/index.ts';
import { color, font } from '../theme.ts';

const FEATURES = [
  {
    title: 'Double-entry invoicing',
    body: 'Every customer invoice and payment posts to a real double-entry ledger, so your books stay balanced by construction.',
  },
  {
    title: 'Payments that reconcile',
    body: 'Record full or partial payments against invoices and watch outstanding balances update in real time.',
  },
  {
    title: 'Two-way QuickBooks sync',
    body: 'Keep invoices and payments in step with QuickBooks Online — idempotent, order-safe, and conflict-aware.',
  },
];

export default function Home() {
  return (
    <MarketingSection>
      <div style={{ maxWidth: 640 }}>
        <div
          style={{
            display: 'inline-block',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: color.brand,
            background: color.brandTint,
            borderRadius: 999,
            padding: '5px 12px',
            marginBottom: 20,
          }}
        >
          Clearbook
        </div>
        <h1
          style={{
            fontSize: 40,
            lineHeight: 1.1,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: color.text,
            margin: '0 0 16px',
          }}
        >
          The invoicing platform that stays in sync
        </h1>
        <p
          style={{
            fontSize: 16.5,
            lineHeight: 1.55,
            color: color.textMuted,
            margin: '0 0 28px',
          }}
        >
          Customer invoicing, payments, and QuickBooks Online sync, in one place — built on a
          double-entry ledger you can trust.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <CtaLink to="/login">Sign in</CtaLink>
          <CtaLink to="/products" variant="secondary">
            See what's inside
          </CtaLink>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 16,
          marginTop: 52,
        }}
      >
        {FEATURES.map((feature) => (
          <Card key={feature.title} padding={20}>
            <div style={{ fontSize: 15, fontWeight: 600, color: color.text, marginBottom: 8 }}>
              {feature.title}
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: color.textMuted }}>
              {feature.body}
            </div>
          </Card>
        ))}
      </div>

      <p
        style={{
          marginTop: 44,
          fontSize: 12.5,
          fontFamily: font.mono,
          color: color.textFaint,
        }}
      >
        Invoices · Payments · Ledger · Sync
      </p>
    </MarketingSection>
  );
}
