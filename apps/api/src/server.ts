/**
 * The HTTP surface.
 *
 * Keep this thin. Routing, credential loading and transport belong here; nothing that
 * decides anything clinical does. The safety kernel lives in `@hc/core` precisely so that it
 * can be reasoned about without reference to a web server.
 */

import { mkdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify, { type FastifyInstance } from 'fastify';
import type { InboundMessage } from '@hc/channels';
import { ChannelError, WhatsAppAdapter, textOf } from '@hc/channels';
import { isImmediate } from '@hc/core';
import { DeepSeekProvider } from '@hc/llm';
import { SqliteCaseStore, type CaseStore } from '@hc/store';

import { describeConfig, loadConfig, type Config } from './config.ts';
import { SeenMessages } from './dedupe.ts';
import { runIntake, summariseOutcome, type PriorContext } from './intake/pipeline.ts';
import { decideReply } from './reply/policy.ts';
import { caseRoutes } from './routes/cases.ts';
import { buildPriorContext } from './intake/context.ts';
import { whatsappRoutes } from './routes/whatsapp.ts';

/**
 * How long an unclosed case keeps absorbing new messages from the same patient.
 *
 * Three days. Long enough that answering a follow-up question the next morning joins the
 * same thread; short enough that a case nobody closed does not silently swallow an
 * unrelated illness weeks later.
 */
const CASE_CONTINUITY_MS = 72 * 60 * 60 * 1000;

export interface ServerDeps {
  /**
   * What to do with each new inbound message.
   *
   * Injected rather than imported so tests can observe it, and so the intake pipeline can
   * be swapped without touching routing.
   */
  readonly onMessage?: (message: InboundMessage) => Promise<void>;
  /** Injected in tests so they can use an in-memory store. */
  readonly store?: CaseStore;
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

  if (config.storePath !== ':memory:' && deps.store === undefined) {
    mkdirSync(dirname(config.storePath), { recursive: true });
  }
  const store = deps.store ?? new SqliteCaseStore({ path: config.storePath });

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
      // Durable de-duplication, before anything else touches the case. The in-memory check
      // in the route forgets everything on restart, and a restart is exactly when Meta is
      // most likely to retry a delivery it never got a 200 for.
      if (!(await store.markProcessed(message.externalId))) {
        app.log.info({ externalId: message.externalId }, 'duplicate message ignored');
        return;
      }

      const patient = await store.resolvePatient(message.channel, message.senderRef, message.senderName);

      let current = await store.findActiveCase(patient.id, CASE_CONTINUITY_MS);
      if (current === null) {
        current = await store.openCase(patient.id);
        await store.append(current.id, [
          { type: 'case.opened', actor: { kind: 'system', component: 'intake' }, data: { channel: message.channel } },
        ]);
      }
      const caseId = current.id;

      // The store is the system of record and holds the patient's words. Logs do not.
      await store.append(caseId, [
        {
          type: 'message.received',
          actor: { kind: 'patient', patientId: patient.id },
          at: message.receivedAt,
          data: {
            externalId: message.externalId,
            parts: message.parts.map((part) => part.kind),
            text: textOf(message),
          },
        },
      ]);

      // Everything the case already knows, replayed from its event log. The kernel is then
      // evaluated against the whole picture rather than the latest message alone.
      const prior: PriorContext = buildPriorContext(await store.eventsFor(caseId));
      const outcome = await runIntake(message, provider, prior);

      await store.append(caseId, [
        {
          type: 'extraction.completed',
          actor: { kind: 'system', component: 'intake-pipeline' },
          data: {
            symptoms: outcome.extraction.symptoms,
            rejected: outcome.extraction.rejected,
            missing: outcome.extraction.missing,
            ageMonths: outcome.extraction.ageMonths ?? null,
            pregnant: outcome.extraction.pregnant ?? null,
            durationHours: outcome.extraction.durationHours ?? null,
            failure: outcome.extractionFailure,
            latencyMs: outcome.latencyMs,
          },
        },
        {
          type: 'safety.evaluated',
          // The kernel version is part of the actor, so a case decided months ago can be
          // replayed against the exact rules that decided it.
          actor: { kind: 'system', component: `safety-kernel@${outcome.verdict.kernelVersion}` },
          data: {
            level: outcome.verdict.level,
            disposition: outcome.verdict.disposition,
            firedRules: outcome.verdict.firedRules.map((rule) => ({ id: rule.id, title: rule.title, detail: rule.evidence.detail })),
            aiSuggestion: outcome.verdict.aiSuggestion ?? null,
            escalatedFromAi: outcome.verdict.escalatedFromAi,
            extractionGaps: outcome.verdict.extractionGaps,
          },
        },
      ]);

      await store.applyVerdict(caseId, {
        level: outcome.verdict.level,
        disposition: outcome.verdict.disposition,
        symptomCodes: outcome.snapshot.symptoms.map((symptom) => symptom.code),
        missing: outcome.extraction.missing,
        firedRuleIds: outcome.verdict.firedRules.map((rule) => rule.id),
        ageMonths: outcome.snapshot.patient.ageMonths,
      });

      app.log.info({ ...summariseOutcome(outcome), caseId, patientId: patient.id }, 'intake complete');

      if (isImmediate(outcome.verdict)) {
        app.log.warn(
          { caseId, level: outcome.verdict.level },
          'EMERGENCY disposition — this case needs a human now',
        );
      }

      const reply = decideReply(outcome.verdict);
      if (!reply.send || whatsapp === null || message.channel !== 'whatsapp') {
        await store.append(caseId, [
          { type: 'reply.suppressed', actor: { kind: 'system', component: 'reply-policy' }, data: { reason: reply.reason } },
        ]);
        app.log.info({ caseId, reason: reply.reason, sent: false }, 'reply decision');
        return;
      }

      try {
        const sent = await whatsapp.sendText(message.senderRef, reply.text);
        await store.append(caseId, [
          {
            type: 'reply.sent',
            actor: { kind: 'system', component: 'reply-policy' },
            data: { reason: reply.reason, text: reply.text, externalId: sent.externalId },
          },
        ]);
        app.log.info({ caseId, reason: reply.reason, sent: true, replyId: sent.externalId }, 'reply decision');
      } catch (error) {
        // Outside the 24-hour service window a free-form reply is refused by Meta. That is
        // an ordinary state of the world, not a fault — but an emergency that could not be
        // delivered must be loud, because nobody is coming to check the log.
        const outsideWindow = error instanceof ChannelError && error.isOutsideServiceWindow;
        await store.append(caseId, [
          {
            type: 'reply.suppressed',
            actor: { kind: 'system', component: 'reply-policy' },
            data: { reason: reply.reason, failed: true, outsideWindow },
          },
        ]);
        const level = reply.reason === 'emergency' ? 'error' : 'warn';
        app.log[level]({ caseId, reason: reply.reason, outsideWindow, error: String(error) }, 'reply could not be delivered');
      }
    });

  app.register(whatsappRoutes, {
    settings: config.whatsapp,
    seen: new SeenMessages(),
    onMessage,
  });

  app.register(caseRoutes, { store, consoleToken: config.consoleToken });

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
