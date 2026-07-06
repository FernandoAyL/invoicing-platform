import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listConflicts, resolveConflict } from '../lib/api.ts';
import Conflicts from './Conflicts.tsx';

vi.mock('../lib/api.ts', () => ({
  listConflicts: vi.fn(),
  resolveConflict: vi.fn(),
}));

function mkConflict(overrides: Record<string, unknown> = {}) {
  return {
    linkId: 'link-1',
    qboType: 'Invoice' as const,
    qboId: 'qbo-inv-1',
    conflictDetectedAt: '2026-07-04T12:00:00.000Z',
    storedSyncToken: '3',
    storedLocalVersion: 1,
    localCurrentVersion: 2,
    transaction: {
      id: 'inv-1',
      type: 'customer_invoice' as const,
      docNumber: 'INV-1',
      total: '100.00',
      status: 'open',
      deletedAt: null,
      updatedAt: '2026-07-04T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('Conflicts list', () => {
  beforeEach(() => {
    vi.mocked(listConflicts).mockReset();
    vi.mocked(resolveConflict).mockReset();
  });

  it('renders a row per conflict with the doc summary, conflict badge, and both resolution actions', async () => {
    vi.mocked(listConflicts).mockResolvedValue([mkConflict()]);

    render(
      <MemoryRouter>
        <Conflicts />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Invoice INV-1')).toBeInTheDocument();
    expect(screen.getByTestId('sync-status-badge')).toHaveTextContent('Conflict');
    expect(screen.getByRole('button', { name: 'Keep mine' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use QuickBooks version' })).toBeInTheDocument();
  });

  it('shows an empty state with no conflicts', async () => {
    vi.mocked(listConflicts).mockResolvedValue([]);

    render(
      <MemoryRouter>
        <Conflicts />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/no conflicts/i)).toBeInTheDocument();
  });

  it('shows an error state when the list fails to load', async () => {
    vi.mocked(listConflicts).mockRejectedValue(new Error('boom'));

    render(
      <MemoryRouter>
        <Conflicts />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/could not load conflicts/i)).toBeInTheDocument();
  });

  it('"Keep mine" calls resolveConflict(linkId, "local") and removes the row on success', async () => {
    vi.mocked(listConflicts).mockResolvedValue([mkConflict()]);
    vi.mocked(resolveConflict).mockResolvedValue({
      linkId: 'link-1',
      state: 'synced',
      winner: 'local',
    });

    render(
      <MemoryRouter>
        <Conflicts />
      </MemoryRouter>,
    );

    const keepMine = await screen.findByRole('button', { name: 'Keep mine' });
    fireEvent.click(keepMine);

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith('link-1', 'local'));
    await waitFor(() => expect(screen.queryByText('Invoice INV-1')).not.toBeInTheDocument());
  });

  it('"Use QuickBooks version" calls resolveConflict(linkId, "qbo") and removes the row on success', async () => {
    vi.mocked(listConflicts).mockResolvedValue([mkConflict()]);
    vi.mocked(resolveConflict).mockResolvedValue({
      linkId: 'link-1',
      state: 'synced',
      winner: 'qbo',
    });

    render(
      <MemoryRouter>
        <Conflicts />
      </MemoryRouter>,
    );

    const useQbo = await screen.findByRole('button', { name: 'Use QuickBooks version' });
    fireEvent.click(useQbo);

    await waitFor(() => expect(resolveConflict).toHaveBeenCalledWith('link-1', 'qbo'));
    await waitFor(() => expect(screen.queryByText('Invoice INV-1')).not.toBeInTheDocument());
  });

  it('shows an error and keeps the row when resolution fails', async () => {
    vi.mocked(listConflicts).mockResolvedValue([mkConflict()]);
    vi.mocked(resolveConflict).mockRejectedValue(new Error('boom'));

    render(
      <MemoryRouter>
        <Conflicts />
      </MemoryRouter>,
    );

    const keepMine = await screen.findByRole('button', { name: 'Keep mine' });
    fireEvent.click(keepMine);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not resolve/i);
    expect(screen.getByText('Invoice INV-1')).toBeInTheDocument();
  });
});
