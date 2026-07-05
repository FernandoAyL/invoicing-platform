import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SyncState } from '../lib/api.ts';
import { SyncStatusBadge } from './SyncStatusBadge.tsx';

const CASES: Array<{ state: SyncState; label: string; title: string }> = [
  { state: 'pending', label: 'Pending', title: 'Not yet synced to QuickBooks' },
  { state: 'synced', label: 'Synced', title: 'Synced with QuickBooks' },
  {
    state: 'conflict',
    label: 'Conflict',
    title: 'Edited in both systems - needs review before syncing again',
  },
  { state: 'failed', label: 'Failed', title: 'The last sync attempt to QuickBooks failed' },
];

describe('SyncStatusBadge', () => {
  it.each(CASES)('renders the $state state with its label and title', ({ state, label, title }) => {
    render(<SyncStatusBadge state={state} />);
    const badge = screen.getByTestId('sync-status-badge');
    expect(badge).toHaveTextContent(label);
    expect(badge).toHaveAttribute('title', title);
    expect(badge).toHaveAttribute('data-state', state);
  });

  it('renders visually distinct states (different background colors)', () => {
    const colors = CASES.map(({ state }) => {
      const { unmount } = render(<SyncStatusBadge state={state} />);
      const color = screen.getByTestId('sync-status-badge').style.backgroundColor;
      unmount();
      return color;
    });
    expect(new Set(colors).size).toBe(CASES.length);
  });
});
