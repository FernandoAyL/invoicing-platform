import { Card } from '../components/ui/Card.tsx';
import { color } from '../theme.ts';

// Phase-1 placeholder. The full Integrations page (QuickBooks connection
// card, sync stats, needs-attention, activity log, resolve/retry) is
// Phase 2 - see docs/design-system.md "Phase-1 scope guards". The sidebar
// nav item routes here rather than a stubbed-out version of that page so we
// never fabricate a "Connected" status before the sync engine exists.
export default function Integrations() {
  return (
    <div style={{ padding: '24px 30px 60px', maxWidth: 1080 }}>
      <Card>
        <div style={{ textAlign: 'center', padding: '40px 20px', color: color.textMuted }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: color.text, marginBottom: 6 }}>
            QuickBooks integration coming in a later phase
          </div>
          <div style={{ fontSize: 13 }}>
            Two-way sync with QuickBooks Online isn't connected yet. This page will show connection
            status, sync activity, and conflicts once it ships.
          </div>
        </div>
      </Card>
    </div>
  );
}
