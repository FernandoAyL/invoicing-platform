import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../lib/api.ts';
import {
  connectQbo,
  disconnectQbo,
  listConflicts,
  listSyncActivity,
  listSyncFailures,
  qboStatus,
  retrySyncFailure,
} from '../lib/api.ts';
import Integrations from './Integrations.tsx';

vi.mock('../lib/api.ts', () => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`API request failed with status ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  return {
    ApiError,
    qboStatus: vi.fn(),
    connectQbo: vi.fn(),
    disconnectQbo: vi.fn(),
    listSyncFailures: vi.fn(),
    retrySyncFailure: vi.fn(),
    listSyncActivity: vi.fn(),
    listConflicts: vi.fn(),
  };
});

const ADMIN_USER: CurrentUser = { id: 'user-1', email: 'admin@example.test', role: 'admin' };
const MEMBER_USER: CurrentUser = { id: 'user-2', email: 'member@example.test', role: 'member' };

let outletUser: CurrentUser = ADMIN_USER;

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useOutletContext: () => outletUser,
  };
});

function renderIntegrations(initialEntry = '/integrations') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/integrations" element={<Integrations />} />
        <Route path="/conflicts" element={<div>Conflicts page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function notConnectedStatus() {
  return {
    connected: false,
    realmId: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
  };
}

function connectedStatus() {
  return {
    connected: true,
    realmId: '123456789',
    accessTokenExpiresAt: '2026-07-07T02:00:00.000Z',
    refreshTokenExpiresAt: '2026-10-05T00:00:00.000Z',
  };
}

describe('Integrations', () => {
  beforeEach(() => {
    outletUser = ADMIN_USER;
    vi.mocked(qboStatus).mockReset();
    vi.mocked(connectQbo).mockReset();
    vi.mocked(disconnectQbo).mockReset();
    vi.mocked(listSyncFailures).mockReset().mockResolvedValue([]);
    vi.mocked(retrySyncFailure).mockReset();
    vi.mocked(listSyncActivity).mockReset().mockResolvedValue([]);
    vi.mocked(listConflicts).mockReset().mockResolvedValue([]);
  });

  it('admin, not connected: shows the Connect button and calls connectQbo on click', async () => {
    vi.mocked(qboStatus).mockResolvedValue(notConnectedStatus());
    vi.mocked(connectQbo).mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderIntegrations();

    expect(await screen.findByText('Not connected to QuickBooks')).toBeInTheDocument();
    const connectButton = screen.getByRole('button', { name: 'Connect QuickBooks' });
    await user.click(connectButton);

    await waitFor(() => expect(connectQbo).toHaveBeenCalledTimes(1));
  });

  it('member, not connected: hides the Connect button but still shows status', async () => {
    outletUser = MEMBER_USER;
    vi.mocked(qboStatus).mockResolvedValue(notConnectedStatus());

    renderIntegrations();

    expect(await screen.findByText('Not connected to QuickBooks')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect QuickBooks' })).not.toBeInTheDocument();
  });

  it('admin, connected: shows the realm + Disconnect, and flips to not-connected on click', async () => {
    vi.mocked(qboStatus)
      .mockResolvedValueOnce(connectedStatus())
      .mockResolvedValueOnce(notConnectedStatus());
    vi.mocked(disconnectQbo).mockResolvedValue({ connected: false });
    const user = userEvent.setup();

    renderIntegrations();

    expect(await screen.findByText('123456789')).toBeInTheDocument();
    const disconnectButton = screen.getByRole('button', { name: 'Disconnect' });
    await user.click(disconnectButton);

    await waitFor(() => expect(disconnectQbo).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not connected to QuickBooks')).toBeInTheDocument();
  });

  it('member, connected: hides Disconnect', async () => {
    outletUser = MEMBER_USER;
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());

    renderIntegrations();

    expect(await screen.findByText('123456789')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });

  it('failed items: renders a failed row with Retry, retries, and the row disappears on refetch', async () => {
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());
    vi.mocked(listSyncFailures)
      .mockReset()
      .mockResolvedValueOnce([
        {
          linkId: 'link-1',
          entityType: 'transaction',
          qboType: 'Invoice',
          qboId: 'qbo-inv-1',
          retryCount: 2,
          nextRetryAt: '2026-07-07T03:00:00.000Z',
          lastError: 'missing item mapping',
          transaction: {
            id: 'inv-1',
            type: 'customer_invoice',
            docNumber: 'INV-1001',
            total: '100.00',
            status: 'open',
          },
        },
      ])
      .mockResolvedValueOnce([]);
    vi.mocked(retrySyncFailure).mockResolvedValue({
      linkId: 'link-1',
      outcome: 'succeeded',
      state: 'synced',
      qboId: 'qbo-inv-1',
    });
    const user = userEvent.setup();

    renderIntegrations();

    expect(await screen.findByText('Invoice INV-1001')).toBeInTheDocument();
    expect(screen.getByTestId('sync-status-badge')).toHaveTextContent('Failed');
    const retryButton = screen.getByRole('button', { name: 'Retry' });
    await user.click(retryButton);

    await waitFor(() => expect(retrySyncFailure).toHaveBeenCalledWith('link-1'));
    await waitFor(() => expect(screen.queryByText('Invoice INV-1001')).not.toBeInTheDocument());
    expect(await screen.findByText('No failed items.')).toBeInTheDocument();
  });

  it('retry 409: shows an inline error and does not crash', async () => {
    const { ApiError } = await import('../lib/api.ts');
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());
    vi.mocked(listSyncFailures)
      .mockReset()
      .mockResolvedValue([
        {
          linkId: 'link-1',
          entityType: 'transaction',
          qboType: 'Invoice',
          qboId: 'qbo-inv-1',
          retryCount: 1,
          nextRetryAt: null,
          lastError: 'timeout',
          transaction: {
            id: 'inv-1',
            type: 'customer_invoice',
            docNumber: 'INV-2002',
            total: '50.00',
            status: 'open',
          },
        },
      ]);
    vi.mocked(retrySyncFailure).mockRejectedValue(new ApiError(409, { error: 'invalid_state' }));
    const user = userEvent.setup();

    renderIntegrations();

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    await user.click(retryButton);

    expect(await screen.findByText('Item is no longer failed.')).toBeInTheDocument();
  });

  it('retry 503: shows "Connect QuickBooks first."', async () => {
    const { ApiError } = await import('../lib/api.ts');
    vi.mocked(qboStatus).mockResolvedValue(notConnectedStatus());
    vi.mocked(listSyncFailures)
      .mockReset()
      .mockResolvedValue([
        {
          linkId: 'link-2',
          entityType: 'transaction',
          qboType: 'Invoice',
          qboId: null,
          retryCount: 0,
          nextRetryAt: null,
          lastError: 'never synced',
          transaction: {
            id: 'inv-2',
            type: 'customer_invoice',
            docNumber: 'INV-3003',
            total: '20.00',
            status: 'open',
          },
        },
      ]);
    vi.mocked(retrySyncFailure).mockRejectedValue(
      new ApiError(503, { error: 'qbo_not_connected' }),
    );
    const user = userEvent.setup();

    renderIntegrations();

    const retryButton = await screen.findByRole('button', { name: 'Retry' });
    await user.click(retryButton);

    expect(await screen.findByText('Connect QuickBooks first.')).toBeInTheDocument();
  });

  it('sync activity: renders newest-first with outcome styling', async () => {
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());
    vi.mocked(listSyncActivity)
      .mockReset()
      .mockResolvedValue([
        {
          id: 'log-3',
          entityType: 'transaction',
          localId: 'inv-1',
          action: 'sync.manual_retry',
          direction: 'outbound',
          outcome: 'failure',
          triggeringEvent: null,
          detail: null,
          createdAt: '2026-07-07T03:00:00.000Z',
        },
        {
          id: 'log-2',
          entityType: 'transaction',
          localId: 'inv-2',
          action: 'qbo.inbound.apply',
          direction: 'inbound',
          outcome: 'skipped',
          triggeringEvent: null,
          detail: null,
          createdAt: '2026-07-07T02:00:00.000Z',
        },
        {
          id: 'log-1',
          entityType: 'qbo_connection',
          localId: null,
          action: 'qbo.connect.initiated',
          direction: 'local',
          outcome: 'success',
          triggeringEvent: null,
          detail: null,
          createdAt: '2026-07-07T01:00:00.000Z',
        },
      ]);

    renderIntegrations();

    const rows = await screen.findAllByTestId('sync-activity-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('sync manual retry');
    expect(rows[0]).toHaveTextContent('Failed');
    expect(rows[1]).toHaveTextContent('qbo inbound apply');
    expect(rows[1]).toHaveTextContent('Skipped');
    expect(rows[2]).toHaveTextContent('qbo connect initiated');
    expect(rows[2]).toHaveTextContent('Success');
  });

  it('sync activity: shows the empty state with no rows', async () => {
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());
    vi.mocked(listSyncActivity).mockReset().mockResolvedValue([]);

    renderIntegrations();

    expect(await screen.findByText('No sync activity yet.')).toBeInTheDocument();
  });

  it('shows a conflicts callout linking to /conflicts when conflicts exist', async () => {
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());
    vi.mocked(listConflicts)
      .mockReset()
      .mockResolvedValue([
        {
          linkId: 'c-1',
          qboType: 'Invoice',
          qboId: 'qbo-1',
          conflictDetectedAt: null,
          storedSyncToken: null,
          storedLocalVersion: null,
          localCurrentVersion: null,
          transaction: null,
        },
      ]);

    renderIntegrations();

    expect(await screen.findByText(/1 conflict needs review/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review conflicts/i })).toHaveAttribute(
      'href',
      '/conflicts',
    );
  });

  it('shows an error banner for ?error=qbo_connect_failed', async () => {
    vi.mocked(qboStatus).mockResolvedValue(notConnectedStatus());

    renderIntegrations('/integrations?error=qbo_connect_failed');

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not connect to quickbooks/i);
  });

  it('shows a success banner for ?connected=1', async () => {
    vi.mocked(qboStatus).mockResolvedValue(connectedStatus());

    renderIntegrations('/integrations?connected=1');

    expect(await screen.findByRole('status')).toHaveTextContent(/connected to quickbooks online/i);
  });
});
