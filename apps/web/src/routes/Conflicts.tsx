import { useCallback, useEffect, useState } from 'react';
import { SyncStatusBadge } from '../components/SyncStatusBadge.tsx';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '../components/ui/index.ts';
import type { Conflict, ConflictWinner } from '../lib/api.ts';
import { listConflicts, resolveConflict } from '../lib/api.ts';
import { formatMoney } from '../lib/money.ts';
import { color, font } from '../theme.ts';

type LoadState = 'loading' | 'loaded' | 'error';

function docLabel(conflict: Conflict): string {
  const txn = conflict.transaction;
  if (!txn) return conflict.qboId;
  const kind = txn.type === 'payment' ? 'Payment' : 'Invoice';
  return txn.docNumber ? `${kind} ${txn.docNumber}` : `${kind} ${txn.id.slice(0, 8)}`;
}

function detectedAtLabel(iso: string | null): string {
  if (!iso) return 'unknown time';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// Phase 2 (20010): pick-a-winner conflict resolution — no merge, no field-by-field diff (that's
// optional/nice-to-have per the plan). Two actions per row: force-push the local record, or pull
// + apply the QBO version. Either way the underlying link returns to `synced` and normal sync
// resumes.
export default function Conflicts() {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [resolvingLinkId, setResolvingLinkId] = useState<string | null>(null);

  const load = useCallback(() => {
    setState('loading');
    listConflicts()
      .then((result) => {
        setConflicts(result);
        setState('loaded');
      })
      .catch(() => setState('error'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleResolve(linkId: string, winner: ConflictWinner) {
    setError(null);
    setResolvingLinkId(linkId);
    try {
      await resolveConflict(linkId, winner);
      setConflicts((current) => current.filter((c) => c.linkId !== linkId));
    } catch {
      setError('Could not resolve this conflict. It may need a fresh QuickBooks connection.');
    } finally {
      setResolvingLinkId(null);
    }
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 30px 60px' }}>
      <PageHeader
        title="Conflicts"
        subtitle="Records edited in both HandyWork and QuickBooks since the last sync. Pick which version wins — nothing syncs again until you do."
      />

      {error ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorState>{error}</ErrorState>
        </div>
      ) : null}

      {state === 'loading' ? <LoadingState label="Loading conflicts…" /> : null}
      {state === 'error' ? <ErrorState>Could not load conflicts.</ErrorState> : null}
      {state === 'loaded' && conflicts.length === 0 ? (
        <EmptyState>No conflicts. Everything in sync is safe to keep syncing.</EmptyState>
      ) : null}

      {state === 'loaded' && conflicts.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {conflicts.map((conflict) => {
            const resolving = resolvingLinkId === conflict.linkId;
            return (
              <Card key={conflict.linkId} padding={18}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        fontSize: 14.5,
                        fontWeight: 600,
                        color: color.text,
                      }}
                    >
                      {docLabel(conflict)}
                      <SyncStatusBadge state="conflict" />
                    </div>
                    <div style={{ fontSize: 12.5, color: color.textMuted, marginTop: 4 }}>
                      Changed in both systems since the last sync — detected{' '}
                      {detectedAtLabel(conflict.conflictDetectedAt)}.
                    </div>
                    {conflict.transaction ? (
                      <div
                        style={{
                          fontFamily: font.mono,
                          fontSize: 12.5,
                          color: color.text2,
                          marginTop: 6,
                        }}
                      >
                        {formatMoney(Number(conflict.transaction.total))} ·{' '}
                        {conflict.transaction.status}
                      </div>
                    ) : null}
                  </div>

                  <div style={{ display: 'flex', gap: 9, flex: 'none' }}>
                    <Button
                      variant="secondary"
                      disabled={resolving}
                      onClick={() => handleResolve(conflict.linkId, 'local')}
                    >
                      {resolving ? 'Resolving…' : 'Keep mine'}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={resolving}
                      onClick={() => handleResolve(conflict.linkId, 'qbo')}
                    >
                      {resolving ? 'Resolving…' : 'Use QuickBooks version'}
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
