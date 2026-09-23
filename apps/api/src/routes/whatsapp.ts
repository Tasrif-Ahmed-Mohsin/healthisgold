/**
 * The WhatsApp webhook.
 *
 * This is the system's only publicly reachable entry point, so it is written with the
 * assumption that everything arriving here is hostile until the signature says otherwise.
 *
 * Three behaviours are deliberate and easy to get wrong:
 *
 *   1. **Signature first, parse second.** Nothing is interpreted before the HMAC verifies.
 *   2. **Always 200 after the signature passes.** Meta retries any non-200 until it gets
 *      one. If a single malformed message makes the handler throw, returning 500 turns that
 *      message into an infinite retry loop. The delivery is acknowledged and the failure is
 *      logged instead.
 *   3. **Acknowledge fast, work afterwards.** Transcription and extraction take seconds;
 *      Meta's patience does not.
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { InboundMessage } from '@hc/channels';
import { parseWhatsAppWebhook, verifySubscription, verifyWhatsAppSignature } from '@hc/channels';

import type { WhatsAppSettings } from '../config.ts';
import type { SeenMessages } from '../dedupe.ts';

export interface WhatsAppRouteOptions extends FastifyPluginOptions {
  readonly settings: WhatsAppSettings | null;
  readonly seen: SeenMessages;
  /**
   * Called once per new message, after the response has been sent.
   *
   * Must not throw in a way the caller depends on — a rejection here is logged and
   * swallowed, because the delivery has already been acknowledged.
   */
  readonly onMessage: (message: InboundMessage) => Promise<void>;
}

interface SubscriptionQuery {
  'hub.mode'?: string;
  'hub.verify_token'?: string;
  'hub.challenge'?: string;
}

export function whatsappRoutes(app: FastifyInstance, options: WhatsAppRouteOptions, done: (error?: Error) => void): void {
  const { settings, seen, onMessage } = options;

  /** Meta's one-time subscription handshake. */
  app.get('/webhooks/whatsapp', async (request: FastifyRequest<{ Querystring: SubscriptionQuery }>, reply) => {
    if (settings === null) {
      return reply.code(503).send({ error: 'WhatsApp is not configured on this server.' });
    }

    const result = verifySubscription(request.query as Record<string, string | undefined>, settings.verifyToken);
    if (!result.ok) {
      request.log.warn({ reason: result.reason }, 'whatsapp subscription handshake rejected');
      return reply.code(403).send({ error: 'Verification failed.' });
    }

    request.log.info('whatsapp subscription handshake accepted');
    // Meta expects the bare challenge string, not JSON.
    return reply.code(200).type('text/plain').send(result.challenge);
  });

  app.post('/webhooks/whatsapp', async (request, reply) => {
    if (settings === null) {
      return reply.code(503).send({ error: 'WhatsApp is not configured on this server.' });
    }

    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      request.log.error('raw body was not captured; signature cannot be verified');
      return reply.code(500).send({ error: 'Server misconfigured.' });
    }

    const signature = request.headers['x-hub-signature-256'];
    const verified = verifyWhatsAppSignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      settings.appSecret,
    );

    if (!verified) {
      // Logged without the body: an unsigned request is untrusted input, and writing it to
      // the log would let anyone who can reach this URL put arbitrary content there.
      request.log.warn({ ip: request.ip }, 'rejected webhook with invalid signature');
      return reply.code(403).send({ error: 'Invalid signature.' });
    }

    const messages = parseWhatsAppWebhook(request.body);
    const fresh = messages.filter((message) => !seen.check(message.externalId));

    // Acknowledge before doing any work. Everything past this point is best-effort.
    reply.code(200).send({ received: messages.length, accepted: fresh.length });

    for (const message of fresh) {
      void onMessage(message).catch((error: unknown) => {
        // The message id is safe to log; the content is not. Patient words never reach a log.
        request.log.error({ externalId: message.externalId, error: String(error) }, 'failed to process inbound message');
      });
    }

    return reply;
  });

  done();
}
