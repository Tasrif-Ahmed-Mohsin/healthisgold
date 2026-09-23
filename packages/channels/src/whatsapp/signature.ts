/**
 * Webhook authenticity.
 *
 * A webhook URL is a public endpoint. Without this check, anyone who discovers the callback
 * URL can post fabricated patient messages straight into a clinical queue — inventing
 * symptoms, impersonating a patient by their phone number, or crafting text designed to
 * manipulate the model that reads it. Signature verification is the only thing standing
 * between the open internet and the intake pipeline.
 *
 * Meta signs the raw request body with the app secret and sends the digest in
 * `X-Hub-Signature-256`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = 'x-hub-signature-256';
const PREFIX = 'sha256=';

export const WHATSAPP_SIGNATURE_HEADER = HEADER;

/**
 * Verifies a webhook signature.
 *
 * `rawBody` must be the **exact bytes** received. Parsing the JSON and re-serialising it
 * changes key order and whitespace, which changes the digest — so a framework that eagerly
 * parses the body will break this check in a way that looks like a credential problem. The
 * server must capture the raw buffer before any JSON parsing.
 */
export function verifyWhatsAppSignature(rawBody: Buffer | string, signatureHeader: string | undefined, appSecret: string): boolean {
  if (signatureHeader === undefined || !signatureHeader.startsWith(PREFIX)) return false;
  if (appSecret === '') return false;

  const provided = Buffer.from(signatureHeader.slice(PREFIX.length), 'hex');
  // A malformed hex header decodes to the wrong length; bail before timingSafeEqual, which
  // throws on a length mismatch rather than returning false.
  if (provided.length !== 32) return false;

  const expected = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest();

  // Constant-time comparison: a plain === leaks the correct digest one byte at a time to
  // anyone able to measure response latency across many attempts.
  return timingSafeEqual(provided, expected);
}

/**
 * Answers Meta's one-time subscription handshake.
 *
 * Meta issues a GET with `hub.mode`, `hub.verify_token` and `hub.challenge`. Echo the
 * challenge back only when the token matches the one configured in `.env`.
 */
export function verifySubscription(
  query: Record<string, string | undefined>,
  expectedVerifyToken: string,
): { ok: true; challenge: string } | { ok: false; reason: string } {
  if (expectedVerifyToken === '') {
    return { ok: false, reason: 'WHATSAPP_VERIFY_TOKEN is not configured' };
  }
  if (query['hub.mode'] !== 'subscribe') {
    return { ok: false, reason: 'hub.mode was not "subscribe"' };
  }
  if (query['hub.verify_token'] !== expectedVerifyToken) {
    return { ok: false, reason: 'verify token did not match' };
  }
  const challenge = query['hub.challenge'];
  if (challenge === undefined || challenge === '') {
    return { ok: false, reason: 'hub.challenge was missing' };
  }
  return { ok: true, challenge };
}
