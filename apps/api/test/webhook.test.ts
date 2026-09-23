import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InboundMessage } from '@hc/channels';

import { ConfigError, loadConfig, type Config, type WhatsAppSettings } from '../src/config.ts';
import { SeenMessages } from '../src/dedupe.ts';
import { buildServer } from '../src/server.ts';

const WHATSAPP: WhatsAppSettings = {
  appId: '1640990257618322',
  phoneNumberId: '106540352242922',
  businessAccountId: '102290129340398',
  accessToken: 'token',
  appSecret: 'app-secret',
  verifyToken: 'verify-me',
  graphVersion: 'v21.0',
};

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    nodeEnv: 'test',
    isProduction: false,
    whatsapp: WHATSAPP,
    llm: null,
    ...overrides,
  };
}

function webhookBody(text: string, messageId = 'wamid.TEST1'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WHATSAPP.businessAccountId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: WHATSAPP.phoneNumberId },
              contacts: [{ profile: { name: 'Patient' }, wa_id: '8801712345678' }],
              messages: [{ from: '8801712345678', id: messageId, timestamp: '1758600000', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
}

function sign(body: string, secret = WHATSAPP.appSecret): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

const servers: { close: () => Promise<void> }[] = [];

function makeServer(cfg: Config, onMessage?: (message: InboundMessage) => Promise<void>) {
  const app = buildServer(cfg, onMessage === undefined ? {} : { onMessage });
  servers.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((app) => app.close()));
});

describe('health', () => {
  it('reports which integrations are configured without revealing them', async () => {
    const app = makeServer(config());
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', whatsapp: 'configured', llm: 'not-configured' });
    expect(response.body).not.toContain(WHATSAPP.appSecret);
    expect(response.body).not.toContain(WHATSAPP.accessToken);
  });
});

describe('subscription handshake', () => {
  it('echoes the challenge as plain text when the token matches', async () => {
    const app = makeServer(config());
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'verify-me', 'hub.challenge': '1158201444' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('1158201444');
  });

  it('rejects a wrong verify token', async () => {
    const app = makeServer(config());
    const response = await app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp',
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'guessed', 'hub.challenge': '1158201444' },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('inbound webhook', () => {
  it('accepts a correctly signed delivery and forwards the message', async () => {
    const onMessage = vi.fn(async (_message: InboundMessage) => {});
    const app = makeServer(config(), onMessage);
    const body = webhookBody('আমার জ্বর');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: 1, accepted: 1 });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ channel: 'whatsapp', senderRef: '8801712345678' });
  });

  it('rejects an unsigned delivery and does not process it', async () => {
    const onMessage = vi.fn(async (_message: InboundMessage) => {});
    const app = makeServer(config(), onMessage);
    const body = webhookBody('injected symptoms');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('rejects a delivery signed with the wrong secret', async () => {
    const onMessage = vi.fn(async (_message: InboundMessage) => {});
    const app = makeServer(config(), onMessage);
    const body = webhookBody('injected symptoms');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, 'attacker-secret') },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('processes a retried delivery only once', async () => {
    const onMessage = vi.fn(async (_message: InboundMessage) => {});
    const app = makeServer(config(), onMessage);
    const body = webhookBody('buke betha', 'wamid.RETRY');
    const headers = { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) };

    const first = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers, payload: body });
    const second = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers, payload: body });

    expect(first.json()).toEqual({ received: 1, accepted: 1 });
    // Still a 200 — Meta must be told to stop retrying even though we did nothing with it.
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ received: 1, accepted: 0 });
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('still acknowledges when processing throws, so Meta stops retrying', async () => {
    const onMessage = vi.fn(async () => {
      throw new Error('pipeline exploded');
    });
    const app = makeServer(config(), onMessage);
    const body = webhookBody('jor', 'wamid.BOOM');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
  });

  it('returns 503 when WhatsApp is not configured', async () => {
    const app = makeServer(config({ whatsapp: null }));
    const body = webhookBody('hello');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body) },
      payload: body,
    });

    expect(response.statusCode).toBe(503);
  });
});

describe('configuration', () => {
  it('runs with no WhatsApp credentials at all', () => {
    const loaded = loadConfig({ PORT: '3000' });

    expect(loaded.whatsapp).toBeNull();
    expect(loaded.llm).toBeNull();
  });

  it('refuses to start on a half-configured integration', () => {
    expect(() =>
      loadConfig({
        WHATSAPP_PHONE_NUMBER_ID: '1',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '2',
        WHATSAPP_ACCESS_TOKEN: '3',
        // app secret and verify token deliberately absent
      }),
    ).toThrow(ConfigError);
  });

  it('names exactly what is missing', () => {
    expect(() => loadConfig({ WHATSAPP_PHONE_NUMBER_ID: '1' })).toThrow(/WHATSAPP_APP_SECRET/);
  });

  it('rejects an invalid port instead of falling back to a default', () => {
    expect(() => loadConfig({ PORT: 'not-a-port' })).toThrow(ConfigError);
  });
});

describe('de-duplication', () => {
  it('reports an id as new once and seen thereafter', () => {
    const seen = new SeenMessages();

    expect(seen.check('a')).toBe(false);
    expect(seen.check('a')).toBe(true);
  });

  it('forgets an id once its TTL passes', () => {
    let now = 1000;
    const seen = new SeenMessages({ ttlMs: 500, now: () => now });

    expect(seen.check('a')).toBe(false);
    now += 600;
    expect(seen.check('a')).toBe(false);
  });

  it('stays bounded under sustained traffic', () => {
    const seen = new SeenMessages({ maxEntries: 10 });

    for (let i = 0; i < 100; i += 1) seen.check(`id-${i}`);

    expect(seen.size).toBeLessThanOrEqual(10);
  });
});
