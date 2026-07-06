import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Intuit's `intuit-signature` header: `base64(HMAC-SHA256(rawBody, verifierToken))`.
 * Must run against the exact raw request bytes, before any JSON parsing — mirrors the
 * constant-time comparison style in `qbo/oauth-state.ts`.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  verifierToken: string,
): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac('sha256', verifierToken).update(rawBody, 'utf8').digest('base64');
  const sigBuf = Buffer.from(signatureHeader, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(sigBuf, expectedBuf);
}
