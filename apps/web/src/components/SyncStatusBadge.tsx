import type { SyncState } from '../lib/api.ts';

// Every invoice legitimately reads "pending" until the Phase-2 sync engine
// starts writing sync_links rows - this component already renders the other
// three states correctly so no UI change is needed when that lands.
const LABELS: Record<SyncState, string> = {
  pending: 'Not synced',
  synced: 'Synced',
  conflict: 'Conflict',
  failed: 'Sync failed',
};

const TITLES: Record<SyncState, string> = {
  pending: 'Not yet synced to QuickBooks',
  synced: 'Synced with QuickBooks',
  conflict: 'Edited in both systems - needs review before syncing again',
  failed: 'The last sync attempt to QuickBooks failed',
};

const STYLES: Record<SyncState, { background: string; color: string }> = {
  pending: { background: '#e5e7eb', color: '#374151' },
  synced: { background: '#dcfce7', color: '#166534' },
  conflict: { background: '#fef3c7', color: '#92400e' },
  failed: { background: '#fee2e2', color: '#991b1b' },
};

export interface SyncStatusBadgeProps {
  state: SyncState;
}

export function SyncStatusBadge({ state }: SyncStatusBadgeProps) {
  const style = STYLES[state];
  return (
    <span
      data-testid="sync-status-badge"
      data-state={state}
      title={TITLES[state]}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '9999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: style.background,
        color: style.color,
      }}
    >
      {LABELS[state]}
    </span>
  );
}
