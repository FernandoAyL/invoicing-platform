import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_MS = 10 * 60 * 1000;

export interface StatePayload {
  orgId: string;
  nonce: string;
  iat: number;
}

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Stateless, signed CSRF token for the OAuth `state` param: `base64url(payload).signature`.
 * Verified with the same server-side `sessionSecret` used for session cookies — no separate
 * env var, no server-side storage to clean up.
 */
export function signState(secret: string, orgId: string, nonce: string): string {
  const payload: StatePayload = { orgId, nonce, iat: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}

/** Returns the decoded payload if the signature matches and it isn't older than 10 minutes, else null. */
export function verifyState(secret: string, token: string): StatePayload | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = sign(secret, payloadB64);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload.orgId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.iat !== 'number'
  ) {
    return null;
  }
  if (Date.now() - payload.iat > MAX_AGE_MS) return null;

  return payload;
}
