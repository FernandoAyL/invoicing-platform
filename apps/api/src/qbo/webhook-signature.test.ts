import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhook-signature.ts';

const TOKEN = 'verifier-token-1';

function sign(body: string, token = TOKEN): string {
  return createHmac('sha256', token).update(body, 'utf8').digest('base64');
}

describe('verifyWebhookSignature', () => {
  it('accepts a correctly computed base64 HMAC signature', () => {
    const body = JSON.stringify({ eventNotifications: [] });
    expect(verifyWebhookSignature(body, sign(body), TOKEN)).toBe(true);
  });

  it('rejects a signature computed with the wrong token', () => {
    const body = JSON.stringify({ eventNotifications: [] });
    expect(verifyWebhookSignature(body, sign(body, 'wrong-token'), TOKEN)).toBe(false);
  });

  it('rejects when the body has been tampered with after signing', () => {
    const original = JSON.stringify({ eventNotifications: [] });
    const signature = sign(original);
    const tampered = JSON.stringify({ eventNotifications: [{ realmId: 'evil' }] });
    expect(verifyWebhookSignature(tampered, signature, TOKEN)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = JSON.stringify({ eventNotifications: [] });
    expect(verifyWebhookSignature(body, undefined, TOKEN)).toBe(false);
  });

  it('rejects a signature of the wrong length without throwing (pre-check before timingSafeEqual)', () => {
    const body = JSON.stringify({ eventNotifications: [] });
    expect(verifyWebhookSignature(body, 'too-short', TOKEN)).toBe(false);
  });

  it('rejects an empty string signature', () => {
    const body = JSON.stringify({ eventNotifications: [] });
    expect(verifyWebhookSignature(body, '', TOKEN)).toBe(false);
  });
});
