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
import { ChannelError, WhatsAppAdapter, textOf } from '@hc/channels';
import { isImmediate } from '@hc/core';
import { DeepSeekProvider } from '@hc/llm';

import { describeConfig, loadConfig, type Config } from './config.ts';
import { SeenMessages } from './dedupe.ts';
import { runIntake, summariseOutcome } from './intake/pipeline.ts';
import { decideReply } from './reply/policy.ts';
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

  const provider =
    config.llm === null
      ? null
      : new DeepSeekProvider({
          apiKey: config.llm.apiKey,
          baseUrl: config.llm.baseUrl,
          fastModel: config.llm.fastModel,
          reasoningModel: config.llm.reasoningModel,
        });

  const whatsapp =
    config.whatsapp === null
      ? null
      : new WhatsAppAdapter({
          phoneNumberId: config.whatsapp.phoneNumberId,
          accessToken: config.whatsapp.accessToken,
          graphVersion: config.whatsapp.graphVersion,
        });

  const onMessage =
    deps.onMessage ??
    (async (message: InboundMessage): Promise<void> => {
      app.log.info(
        {
          channel: message.channel,
          externalId: message.externalId,
          parts: message.parts.map((part) => part.kind),
          textLength: textOf(message).length,
        },
        'inbound message received',
      );

      const outcome = await runIntake(message, provider);
      app.log.info(summariseOutcome(outcome), 'intake complete');

      // Until the case store and coordinator console exist, an emergency has nowhere to go
      // but the log. Say so loudly rather than letting it look handled.
      if (isImmediate(outcome.verdict)) {
        app.log.warn(
          { externalId: outcome.externalId, level: outcome.verdict.level },
          'EMERGENCY disposition — no queue exists yet, this case needs a human now',
        );
      }

      const reply = decideReply(outcome.verdict);
      if (!reply.send || whatsapp === null || message.channel !== 'whatsapp') {
        app.log.info({ externalId: outcome.externalId, reason: reply.reason, sent: false }, 'reply decision');
        return;
      }

      try {
        const sent = await whatsapp.sendText(message.senderRef, reply.text);
        app.log.info(
          { externalId: outcome.externalId, reason: reply.reason, sent: true, replyId: sent.externalId },
          'reply decision',
        );
      } catch (error) {
        // Outside the 24-hour service window a free-form reply is refused by Meta. That is
        // an ordinary state of the world, not a fault — but an emergency that could not be
        // delivered must be loud, because nobody is coming to check the log.
        const outsideWindow = error instanceof ChannelError && error.isOutsideServiceWindow;
        const level = reply.reason === 'emergency' ? 'error' : 'warn';
        app.log[level](
          { externalId: outcome.externalId, reason: reply.reason, outsideWindow, error: String(error) },
          'reply could not be delivered',
        );
      }
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
