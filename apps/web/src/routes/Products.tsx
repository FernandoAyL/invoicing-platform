import { MarketingSection } from '../components/marketing/PublicLayout.tsx';
import { Card } from '../components/ui/index.ts';
import { color } from '../theme.ts';

const PRODUCTS = [
  {
    title: 'Customer invoicing',
    body: 'Create and edit invoices with line items on a double-entry ledger. Statuses track open, partially paid, paid, and void.',
  },
  {
    title: 'Payment recording',
    body: 'Apply full or partial payments against an invoice into a deposit account, with overpayment protection built in.',
  },
  {
    title: 'Two-way QuickBooks sync',
    body: 'Propagate creates, edits, and voids to QuickBooks Online and back — deduplicated, order-safe, and conflict-aware.',
  },
];

export default function Products() {
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
        Products
      </h1>
      <p style={{ fontSize: 15, color: color.textMuted, margin: '0 0 28px', maxWidth: 560 }}>
        Everything you need to invoice customers, take payments, and keep the books in sync.
      </p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 16,
        }}
      >
        {PRODUCTS.map((product) => (
          <Card key={product.title} padding={20}>
            <div style={{ fontSize: 15, fontWeight: 600, color: color.text, marginBottom: 8 }}>
              {product.title}
            </div>
            <div style={{ fontSize: 13.5, lineHeight: 1.55, color: color.textMuted }}>
              {product.body}
            </div>
          </Card>
        ))}
      </div>
    </MarketingSection>
  );
}
