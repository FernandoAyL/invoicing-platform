import type { SyncState } from '../lib/api.ts';
import { color, font, radius } from '../theme.ts';

// Every invoice legitimately reads "pending" until the Phase-2 sync engine
// starts writing sync_links rows - this component already renders the other
// three states correctly so no UI change is needed when that lands.
// Labels match docs/design-system.md's "Status badge -> syncState" table
// verbatim (Pending / Synced / Conflict / Failed); the `title` tooltips below
// still carry the longer, more descriptive copy.
const LABELS: Record<SyncState, string> = {
  pending: 'Pending',
  synced: 'Synced',
  conflict: 'Conflict',
  failed: 'Failed',
};

const TITLES: Record<SyncState, string> = {
  pending: 'Not yet synced to QuickBooks',
  synced: 'Synced with QuickBooks',
  conflict: 'Edited in both systems - needs review before syncing again',
  failed: 'The last sync attempt to QuickBooks failed',
};

// Colors per docs/design-system.md "Status badge -> syncState". Conflict and
// failed share the same text/bg *family* in the design system (both are the
// "conflict/failed/void/danger" red group) but need visually distinct
// backgrounds to stay distinguishable in the UI - the design system lists
// two shades for that family (#fdf1ef / #fbe9e7); conflict takes the
// lighter one, failed the stronger one.
const STYLES: Record<SyncState, { background: string; color: string }> = {
  pending: { background: color.statusWarnBg, color: color.statusWarnText },
  synced: { background: color.statusSuccessBg, color: color.statusSuccessText },
  conflict: { background: color.statusDangerBg, color: color.statusDangerTextStrong },
  failed: { background: color.statusDangerBgStrong, color: color.statusDangerText },
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
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 9px',
        borderRadius: radius.pill,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.02em',
        fontFamily: font.mono,
        whiteSpace: 'nowrap',
        backgroundColor: style.background,
        color: style.color,
      }}
    >
      {LABELS[state]}
    </span>
  );
}
