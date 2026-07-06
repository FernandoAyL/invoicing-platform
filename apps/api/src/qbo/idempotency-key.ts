export interface OutboundIdempotencyKeyInput {
  orgId: string;
  entityType: string;
  localId: string;
  /** The local record's version at the time of the write attempt. Included so a retry of the
   * *same* version reuses the same key (safely de-dupable by the outbound engine), while a write
   * attempt for a *later* version gets a distinct key (it's a genuinely new push, not a retry). */
  localVersion: number;
}

/**
 * Pure, deterministic derivation of the outbound idempotency key: a stable identifier the
 * outbound-sync engine (20006) attaches to a QBO write so a retried create/update of the same
 * local-record version is recognizable as "already attempted" rather than re-executed as a new
 * write. No network call here — this only derives the string.
 */
export function outboundIdempotencyKey(input: OutboundIdempotencyKeyInput): string {
  const { orgId, entityType, localId, localVersion } = input;
  return `${orgId}:${entityType}:${localId}:v${localVersion}`;
}
