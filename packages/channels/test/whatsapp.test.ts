import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { textOf } from '../src/adapter.js';
import { parseWhatsAppWebhook } from '../src/whatsapp/inbound.js';
import { verifySubscription, verifyWhatsAppSignature } from '../src/whatsapp/signature.js';

const SECRET = 'test-app-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function textWebhook(body: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550123456', phone_number_id: '106540352242922' },
              contacts: [{ profile: { name: 'Test Patient' }, wa_id: '8801712345678' }],
              messages: [
                {
                  from: '8801712345678',
                  id: 'wamid.HBgNODgwMTcxMjM0NTY3OBUCABIYFjNBMEQ',
                  timestamp: '1758600000',
                  type: 'text',
                  text: { body },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

describe('webhook signature verification', () => {
  const body = JSON.stringify(textWebhook('jor hoyeche'));

  it('accepts a correctly signed body', () => {
    expect(verifyWhatsAppSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyWhatsAppSignature(body, sign(body, 'wrong-secret'), SECRET)).toBe(false);
  });

  it('rejects a body that changed after signing', () => {
    const signature = sign(body);
    const tampered = body.replace('jor hoyeche', 'buke betha');

    expect(verifyWhatsAppSignature(tampered, signature, SECRET)).toBe(false);
  });

  it('rejects a missing or malformed header without throwing', () => {
    expect(verifyWhatsAppSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, 'nonsense', SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, 'sha256=zzzz', SECRET)).toBe(false);
    expect(verifyWhatsAppSignature(body, 'sha256=abcd', SECRET)).toBe(false);
  });

  it('rejects everything when no app secret is configured', () => {
    expect(verifyWhatsAppSignature(body, sign(body, ''), '')).toBe(false);
  });

  it('verifies a Buffer body identically to a string body', () => {
    expect(verifyWhatsAppSignature(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });
});

describe('subscription handshake', () => {
  it('echoes the challenge when the token matches', () => {
    const result = verifySubscription(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'expected', 'hub.challenge': '1158201444' },
      'expected',
    );

    expect(result).toEqual({ ok: true, challenge: '1158201444' });
  });

  it('refuses a mismatched token', () => {
    const result = verifySubscription(
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'guessed', 'hub.challenge': '1158201444' },
      'expected',
    );

    expect(result.ok).toBe(false);
  });

  it('refuses when no verify token is configured', () => {
    const result = verifySubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'x' }, '');

    expect(result.ok).toBe(false);
  });
});

describe('inbound parsing', () => {
  it('normalises a text message', () => {
    const [message] = parseWhatsAppWebhook(textWebhook('আমার ৩ দিন ধরে জ্বর'));

    expect(message).toBeDefined();
    expect(message?.channel).toBe('whatsapp');
    expect(message?.senderRef).toBe('8801712345678');
    expect(message?.senderName).toBe('Test Patient');
    expect(textOf(message!)).toBe('আমার ৩ দিন ধরে জ্বর');
  });

  it('converts the Unix timestamp to ISO', () => {
    const [message] = parseWhatsAppWebhook(textWebhook('hello'));

    expect(message?.receivedAt).toBe(new Date(1_758_600_000 * 1000).toISOString());
  });

  it('carries a voice note as a media reference rather than bytes', () => {
    const [message] = parseWhatsAppWebhook(
      textWebhook('', { type: 'audio', text: undefined, audio: { id: 'media-123', mime_type: 'audio/ogg; codecs=opus' } }),
    );

    expect(message?.parts[0]).toEqual({ kind: 'audio', mediaId: 'media-123', mimeType: 'audio/ogg; codecs=opus' });
  });

  it('keeps an image caption', () => {
    const [message] = parseWhatsAppWebhook(
      textWebhook('', { type: 'image', text: undefined, image: { id: 'media-9', mime_type: 'image/jpeg', caption: 'prescription' } }),
    );

    expect(message?.parts[0]).toMatchObject({ kind: 'image', mediaId: 'media-9', caption: 'prescription' });
  });

  it('ignores delivery receipts', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: '1', changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.x', status: 'delivered' }] } }] }],
    };

    expect(parseWhatsAppWebhook(payload)).toEqual([]);
  });

  it('degrades an unknown message type instead of throwing', () => {
    const [message] = parseWhatsAppWebhook(textWebhook('', { type: 'sticker', text: undefined, sticker: { id: 's-1' } }));

    expect(message?.parts[0]).toEqual({ kind: 'unsupported', description: 'unhandled message type: sticker' });
  });

  it('survives malformed payloads', () => {
    for (const payload of [undefined, null, 'string', 42, [], {}, { entry: 'not-an-array' }, { entry: [null] }]) {
      expect(() => parseWhatsAppWebhook(payload)).not.toThrow();
      expect(parseWhatsAppWebhook(payload)).toEqual([]);
    }
  });

  it('skips a message with no id, since it cannot be de-duplicated', () => {
    const [message] = parseWhatsAppWebhook(textWebhook('hi', { id: undefined }));

    expect(message).toBeUndefined();
  });
});
