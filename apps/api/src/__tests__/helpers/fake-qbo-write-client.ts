import type {
  GetEntityParams,
  QboApiClient,
  QboEntityEnvelope,
  QboEntityType,
  VoidEntityParams,
  WriteEntityParams,
} from '../../qbo/api-client.ts';
import { QboNotFoundError } from '../../qbo/errors.ts';

export interface FakeQboCall {
  method: 'get' | 'create' | 'update' | 'void';
  entityType: QboEntityType;
  qboId?: string;
  body?: Record<string, unknown>;
}

export interface FakeQboWriteClient extends QboApiClient {
  calls: FakeQboCall[];
  countOf(method: FakeQboCall['method'], entityType: QboEntityType): number;
}

export interface FakeQboWriteClientOptions {
  /** Return an Error to make the given call fail instead of succeeding; return/undefined lets
   * it through. Called before the call is recorded as a success. */
  failOn?: (call: FakeQboCall) => Error | undefined;
}

/**
 * In-memory fake of the write-capable QBO client for outbound-sync tests — no live Intuit call
 * ever happens (repo phase rule). Tracks every call (so tests can assert e.g. "create was only
 * called once even on a retried push") and assigns incrementing Ids/SyncTokens so
 * create-then-update sequences behave like the real API (each write bumps SyncToken).
 */
export function createFakeQboWriteClient(opts: FakeQboWriteClientOptions = {}): FakeQboWriteClient {
  const calls: FakeQboCall[] = [];
  const store = new Map<string, { body: Record<string, unknown>; syncToken: number }>();
  let seq = 0;

  function key(entityType: QboEntityType, id: string): string {
    return `${entityType}:${id}`;
  }

  function maybeFail(call: FakeQboCall): void {
    const err = opts.failOn?.(call);
    if (err) throw err;
  }

  return {
    calls,
    countOf(method, entityType) {
      return calls.filter((c) => c.method === method && c.entityType === entityType).length;
    },

    async getEntity({ entityType, qboId }: GetEntityParams): Promise<QboEntityEnvelope> {
      const call: FakeQboCall = { method: 'get', entityType, qboId };
      calls.push(call);
      maybeFail(call);
      const record = store.get(key(entityType, qboId));
      if (!record) throw new QboNotFoundError(`fake: not found ${entityType}:${qboId}`);
      return { [entityType]: { ...record.body, Id: qboId, SyncToken: String(record.syncToken) } };
    },

    async createEntity({ entityType, body }: WriteEntityParams): Promise<QboEntityEnvelope> {
      const call: FakeQboCall = { method: 'create', entityType, body };
      calls.push(call);
      maybeFail(call);
      seq += 1;
      const id = String(seq);
      store.set(key(entityType, id), { body, syncToken: 0 });
      // Field order matters: `...body` first so the fake's own Id/SyncToken always win over
      // anything (coincidentally) present in the request body.
      return { [entityType]: { ...body, Id: id, SyncToken: '0' } };
    },

    async updateEntity({ entityType, body }: WriteEntityParams): Promise<QboEntityEnvelope> {
      const call: FakeQboCall = { method: 'update', entityType, qboId: body.Id as string, body };
      calls.push(call);
      maybeFail(call);
      const id = body.Id as string;
      const existing = store.get(key(entityType, id));
      const nextToken = (existing?.syncToken ?? 0) + 1;
      store.set(key(entityType, id), { body, syncToken: nextToken });
      return { [entityType]: { ...body, Id: id, SyncToken: String(nextToken) } };
    },

    async voidEntity({ entityType, qboId }: VoidEntityParams): Promise<QboEntityEnvelope> {
      const call: FakeQboCall = { method: 'void', entityType, qboId };
      calls.push(call);
      maybeFail(call);
      const existing = store.get(key(entityType, qboId));
      const nextToken = (existing?.syncToken ?? 0) + 1;
      if (existing)
        store.set(key(entityType, qboId), { body: existing.body, syncToken: nextToken });
      return { [entityType]: { Id: qboId, SyncToken: String(nextToken) } };
    },
  };
}
