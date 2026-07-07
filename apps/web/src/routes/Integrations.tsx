import { useCallback, useEffect, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../components/ui/index.ts';
import type {
  Conflict,
  CurrentUser,
  QboStatus,
  SyncActivityDirection,
  SyncActivityEntry,
  SyncActivityOutcome,
  SyncFailure,
} from '../lib/api.ts';
import {
  ApiError,
  connectQbo,
  disconnectQbo,
  listConflicts,
  listSyncActivity,
  listSyncFailures,
  qboStatus,
  retrySyncFailure,
} from '../lib/api.ts';
import { color, font } from '../theme.ts';

type LoadState = 'loading' | 'loaded' | 'error';

const DIRECTION_LABELS: Record<SyncActivityDirection, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound',
  local: 'Local',
};

const OUTCOME_LABELS: Record<SyncActivityOutcome, string> = {
  success: 'Success',
  failure: 'Failed',
  skipped: 'Skipped',
};

const OUTCOME_STYLES: Record<SyncActivityOutcome, { background: string; color: string }> = {
  success: { background: color.statusSuccessBg, color: color.statusSuccessText },
  failure: { background: color.statusDangerBgStrong, color: color.statusDangerText },
  skipped: { background: color.statusWarnBg, color: color.statusWarnText },
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function failureLabel(failure: SyncFailure): string {
  const txn = failure.transaction;
  if (!txn) return `${failure.qboType} ${failure.qboId ?? failure.linkId.slice(0, 8)}`;
  const kind = txn.type === 'payment' ? 'Payment' : 'Invoice';
  return txn.docNumber ? `${kind} ${txn.docNumber}` : `${kind} ${txn.id.slice(0, 8)}`;
}

function actionLabel(action: string): string {
  // Actions are dot/underscore-separated identifiers (e.g. "qbo.connect.initiated",
  // "sync.manual_retry") - render the whole identifier as plain words.
  return action.replace(/[._]/g, ' ');
}

/** A non-403/non-network ApiError falls back to a generic message; 403s (a non-admin somehow
 * triggering an admin-only action) get a dedicated message per the plan's edge cases. */
function connectionErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.status === 503) return "QuickBooks isn't configured in this environment.";
    if (err.status === 403) return "You don't have permission to do that.";
  }
  return fallback;
}

export default function Integrations() {
  const user = useOutletContext<CurrentUser>();
  const isAdmin = user.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();

  const [status, setStatus] = useState<QboStatus | null>(null);
  const [statusState, setStatusState] = useState<LoadState>('loading');
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const [failures, setFailures] = useState<SyncFailure[]>([]);
  const [failuresState, setFailuresState] = useState<LoadState>('loading');
  const [retryingLinkId, setRetryingLinkId] = useState<string | null>(null);
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});

  const [conflictCount, setConflictCount] = useState<number | null>(null);

  const [activity, setActivity] = useState<SyncActivityEntry[]>([]);
  const [activityState, setActivityState] = useState<LoadState>('loading');

  // Captured ONCE from the params present on first mount (the lazy `useState` initializer only
  // ever runs once) - the banner must stay visible even after the effect below clears the URL, or
  // it would vanish the instant the params are removed since it'd otherwise be re-derived from
  // (now-empty) `searchParams` on every render.
  const [banner] = useState<{ kind: 'success' | 'error'; message: string } | null>(() => {
    if (searchParams.get('connected') === '1') {
      return { kind: 'success', message: 'Connected to QuickBooks Online.' };
    }
    if (searchParams.get('error') === 'qbo_connect_failed') {
      return { kind: 'error', message: 'Could not connect to QuickBooks. Please try again.' };
    }
    return null;
  });

  useEffect(() => {
    if (searchParams.get('connected') === null && searchParams.get('error') === null) return;
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('error');
    setSearchParams(next, { replace: true });
    // Clearing the params re-runs this effect (searchParams changes), but by then both `get()`
    // calls above are null and the guard stops it - no infinite loop, and a refresh after this
    // point hits a clean URL so the banner won't re-show.
  }, [searchParams, setSearchParams]);

  const loadStatus = useCallback(() => {
    setStatusState('loading');
    qboStatus()
      .then((result) => {
        setStatus(result);
        setStatusState('loaded');
      })
      .catch(() => setStatusState('error'));
  }, []);

  const loadFailures = useCallback(() => {
    setFailuresState('loading');
    listSyncFailures()
      .then((result) => {
        setFailures(result);
        setFailuresState('loaded');
      })
      .catch(() => setFailuresState('error'));
  }, []);

  const loadActivity = useCallback(() => {
    setActivityState('loading');
    listSyncActivity()
      .then((result) => {
        setActivity(result);
        setActivityState('loaded');
      })
      .catch(() => setActivityState('error'));
  }, []);

  const loadConflictCount = useCallback(() => {
    listConflicts()
      .then((result: Conflict[]) => setConflictCount(result.length))
      .catch(() => setConflictCount(null));
  }, []);

  useEffect(() => {
    loadStatus();
    loadFailures();
    loadActivity();
    loadConflictCount();
  }, [loadStatus, loadFailures, loadActivity, loadConflictCount]);

  async function handleConnect() {
    setConnectionError(null);
    setConnecting(true);
    try {
      await connectQbo();
      // connectQbo navigates the browser away on success; nothing left to do here.
    } catch (err) {
      setConnectionError(connectionErrorMessage(err, 'Could not start the QuickBooks connection.'));
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setConnectionError(null);
    setDisconnecting(true);
    try {
      await disconnectQbo();
      loadStatus();
    } catch (err) {
      setConnectionError(connectionErrorMessage(err, 'Could not disconnect QuickBooks.'));
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleRetry(linkId: string) {
    setRetryErrors((current) => {
      const next = { ...current };
      delete next[linkId];
      return next;
    });
    setRetryingLinkId(linkId);
    try {
      await retrySyncFailure(linkId);
      loadFailures();
      loadActivity();
    } catch (err) {
      let message = 'Could not retry this item.';
      if (err instanceof ApiError) {
        if (err.status === 409) {
          message = 'Item is no longer failed.';
          loadFailures();
        } else if (err.status === 503) {
          message = 'Connect QuickBooks first.';
        }
      }
      setRetryErrors((current) => ({ ...current, [linkId]: message }));
    } finally {
      setRetryingLinkId(null);
    }
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 30px 60px' }}>
      <PageHeader
        title="Integrations"
        subtitle="Connection status, sync activity, and failed items for QuickBooks Online."
      />

      {banner ? (
        <div style={{ marginBottom: 16 }}>
          {banner.kind === 'success' ? (
            <div
              role="status"
              style={{
                background: color.statusSuccessBg,
                border: `1px solid ${color.border}`,
                borderRadius: 13,
                padding: '14px 18px',
                color: color.statusSuccessText,
                fontSize: 13.5,
                fontWeight: 500,
              }}
            >
              {banner.message}
            </div>
          ) : (
            // ErrorState already renders role="alert" - don't double it up on a wrapper.
            <ErrorState>{banner.message}</ErrorState>
          )}
        </div>
      ) : null}

      {connectionError ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorState>{connectionError}</ErrorState>
        </div>
      ) : null}

      {/* Connection card */}
      <div style={{ marginBottom: 16 }}>
        {statusState === 'loading' ? <LoadingState label="Loading connection status…" /> : null}
        {statusState === 'error' ? (
          <ErrorState>Could not load connection status.</ErrorState>
        ) : null}
        {statusState === 'loaded' && status ? (
          <Card>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
                flexWrap: 'wrap',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ fontSize: 15.5, fontWeight: 700, color: color.text }}>
                    QuickBooks Online
                  </span>
                  {status.connected ? (
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: color.statusSuccessText,
                        background: color.statusSuccessBg,
                        padding: '3px 9px',
                        borderRadius: 999,
                      }}
                    >
                      Connected
                    </span>
                  ) : null}
                </div>
                {status.connected ? (
                  <div style={{ fontSize: 12.5, color: color.textMuted, marginTop: 3 }}>
                    realm <span style={{ fontFamily: font.mono }}>{status.realmId}</span>
                  </div>
                ) : (
                  <div style={{ fontSize: 12.5, color: color.textMuted, marginTop: 3 }}>
                    Not connected to QuickBooks
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 9 }}>
                {!status.connected && isAdmin ? (
                  <Button variant="primary" disabled={connecting} onClick={handleConnect}>
                    {connecting ? 'Connecting…' : 'Connect QuickBooks'}
                  </Button>
                ) : null}
                {status.connected && isAdmin ? (
                  <Button variant="danger" disabled={disconnecting} onClick={handleDisconnect}>
                    {disconnecting ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                ) : null}
              </div>
            </div>

            {status.connected ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 12,
                  marginTop: 18,
                  paddingTop: 16,
                  borderTop: `1px solid ${color.borderSoft}`,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      color: color.textFaintAlt,
                      fontWeight: 600,
                      letterSpacing: '0.03em',
                    }}
                  >
                    ACCESS TOKEN EXPIRES
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, marginTop: 4 }}>
                    {formatDateTime(status.accessTokenExpiresAt)}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      color: color.textFaintAlt,
                      fontWeight: 600,
                      letterSpacing: '0.03em',
                    }}
                  >
                    REFRESH TOKEN EXPIRES
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 500, marginTop: 4 }}>
                    {formatDateTime(status.refreshTokenExpiresAt)}
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>

      {/* Conflicts callout */}
      {conflictCount !== null && conflictCount > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <Card
            padding={16}
            style={{ borderColor: color.statusDangerBorder, background: color.statusDangerBg }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span
                style={{ fontSize: 13.5, fontWeight: 600, color: color.statusDangerTextStrong }}
              >
                {conflictCount} {conflictCount === 1 ? 'conflict needs' : 'conflicts need'} review
              </span>
              <Link to="/conflicts" style={{ fontSize: 13, fontWeight: 600, color: color.brand }}>
                Review conflicts →
              </Link>
            </div>
          </Card>
        </div>
      ) : null}

      {/* Needs attention (failed items) */}
      <div style={{ marginBottom: 16 }}>
        <Card header="Needs attention" padding={0}>
          {failuresState === 'loading' ? (
            <div style={{ padding: 18 }}>
              <LoadingState label="Loading failed items…" />
            </div>
          ) : null}
          {failuresState === 'error' ? (
            <div style={{ padding: 18 }}>
              <ErrorState>Could not load failed items.</ErrorState>
            </div>
          ) : null}
          {failuresState === 'loaded' && failures.length === 0 ? (
            <div style={{ padding: 18 }}>
              <EmptyState>No failed items.</EmptyState>
            </div>
          ) : null}
          {failuresState === 'loaded' && failures.length > 0
            ? failures.map((failure) => {
                const retrying = retryingLinkId === failure.linkId;
                const retryError = retryErrors[failure.linkId];
                return (
                  <div
                    key={failure.linkId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '13px 18px',
                      borderBottom: `1px solid ${color.borderSoft}`,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <span style={{ fontFamily: font.mono, fontSize: 13, fontWeight: 500 }}>
                          {failureLabel(failure)}
                        </span>
                        <SyncStatusBadge state="failed" />
                      </div>
                      <div style={{ fontSize: 12, color: color.statusDangerText, marginTop: 2 }}>
                        {failure.lastError ?? 'Sync failed'} · retried {failure.retryCount}{' '}
                        {failure.retryCount === 1 ? 'time' : 'times'}
                      </div>
                      {retryError ? (
                        <div style={{ fontSize: 12, color: color.statusDangerText, marginTop: 2 }}>
                          {retryError}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      variant="danger"
                      disabled={retrying}
                      onClick={() => handleRetry(failure.linkId)}
                    >
                      {retrying ? 'Retrying…' : 'Retry'}
                    </Button>
                  </div>
                );
              })
            : null}
        </Card>
      </div>

      {/* Sync activity log */}
      <Card header="Sync activity log" padding={0}>
        {activityState === 'loading' ? (
          <div style={{ padding: 18 }}>
            <LoadingState label="Loading sync activity…" />
          </div>
        ) : null}
        {activityState === 'error' ? (
          <div style={{ padding: 18 }}>
            <ErrorState>Could not load sync activity.</ErrorState>
          </div>
        ) : null}
        {activityState === 'loaded' && activity.length === 0 ? (
          <div style={{ padding: 18 }}>
            <EmptyState>No sync activity yet.</EmptyState>
          </div>
        ) : null}
        {activityState === 'loaded' && activity.length > 0
          ? activity.map((entry) => (
              <div
                key={entry.id}
                data-testid="sync-activity-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '160px 100px 1fr 90px',
                  gap: 12,
                  padding: '12px 18px',
                  borderBottom: `1px solid ${color.borderSoft}`,
                  alignItems: 'center',
                }}
              >
                <div style={{ fontFamily: font.mono, fontSize: 11.5, color: color.textFaintAlt }}>
                  {formatDateTime(entry.createdAt)}
                </div>
                <div style={{ fontSize: 12, color: color.textMuted }}>
                  {DIRECTION_LABELS[entry.direction]}
                </div>
                <div style={{ minWidth: 0, fontSize: 12.5, color: color.text2 }}>
                  {actionLabel(entry.action)}
                  {entry.entityType ? (
                    <span style={{ color: color.textFaint }}> · {entry.entityType}</span>
                  ) : null}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      padding: '3px 9px',
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 600,
                      ...OUTCOME_STYLES[entry.outcome],
                    }}
                  >
                    {OUTCOME_LABELS[entry.outcome]}
                  </span>
                </div>
              </div>
            ))
          : null}
      </Card>
    </div>
  );
}
