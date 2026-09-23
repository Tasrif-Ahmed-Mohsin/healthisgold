/**
 * The HTTP surface.
 *
 * Keep this thin. Routing, credential loading and transport belong here; nothing that
 * decides anything clinical does. The safety kernel lives in `@hc/core` precisely so that it
 * can be reasoned about without reference to a web server.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import type { InboundMessage } from '@hc/channels';
import { textOf } from '@hc/channels';

import { describeConfig, loadConfig, type Config } from './config.ts';
import { SeenMessages } from './dedupe.ts';
import { whatsappRoutes } from './routes/whatsapp.ts';

export interface ServerDeps {
  /**
   * What to do with each new inbound message.
   *
   * Injected rather than imported so tests can observe it, and so the intake pipeline can
   * be swapped without touching routing.
   */
  readonly onMessage?: (message: InboundMessage) => Promise<void>;
}

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.isProduction ? 'info' : 'debug',
      redact: {
        // Credentials pass through headers on outbound calls and can be echoed back by
        // error-handling middleware. Redact them at the logger so no future code path can
        // put a token in a log file by accident.
        paths: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
    // Meta's payloads are small. A low cap is a cheap defence against a body-size attack on
    // a public endpoint.
    bodyLimit: 1024 * 1024,
  });

  /**
   * Capture the raw body before parsing.
   *
   * Registered for every JSON route rather than only the webhook, so a future channel
   * adapter that also needs signature verification cannot forget to opt in.
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = body as Buffer;
    request.rawBody = buffer;

    if (buffer.length === 0) {
      done(null, {});
      return;
    }

    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      // Keep the raw body available: an unparseable payload still needs its signature
      // checked before we decide whether to care about it.
      done(null, undefined);
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    whatsapp: config.whatsapp === null ? 'not-configured' : 'configured',
    llm: config.llm === null ? 'not-configured' : config.llm.provider,
  }));

  const onMessage =
    deps.onMessage ??
    (async (message: InboundMessage): Promise<void> => {
      // Placeholder until the intake pipeline lands. Logs the shape of what arrived and
      // the length of any text — never the text itself, which is health data.
      app.log.info(
        {
          channel: message.channel,
          externalId: message.externalId,
          parts: message.parts.map((part) => part.kind),
          textLength: textOf(message).length,
        },
        'inbound message received',
      );
    });

  app.register(whatsappRoutes, {
    settings: config.whatsapp,
    seen: new SeenMessages(),
    onMessage,
  });

  return app;
}

/** Entry point. Only runs when this file is executed directly, so tests can import freely. */
async function main(): Promise<void> {
  const config = loadConfig();
  const app = buildServer(config);

  app.log.info(`starting\n  ${describeConfig(config)}`);

  if (config.whatsapp === null) {
    app.log.warn('WhatsApp is not configured — the webhook will return 503. See docs/whatsapp-setup.md.');
  }

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    app.log.error(error, 'failed to start');
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  void main();
}
