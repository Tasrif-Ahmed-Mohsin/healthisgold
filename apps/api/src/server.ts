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
import { WhatsAppAdapter, type InboundMessage } from '@hc/channels';
import { DeepSeekProvider } from '@hc/llm';
import { SqliteAuthStore, SqliteCaseStore, type AuthStore, type CaseStore } from '@hc/store';

import { resolvePrincipal } from './auth/session.ts';
import { describeConfig, loadConfig, type Config } from './config.ts';
import { SeenMessages } from './dedupe.ts';
import { createInboundHandler } from './intake/handle.ts';
import { authRoutes } from './routes/auth.ts';
import { caseRoutes } from './routes/cases.ts';
import { patientRoutes } from './routes/patient.ts';
import { staffRoutes } from './routes/staff.ts';
import { whatsappRoutes } from './routes/whatsapp.ts';

export interface ServerDeps {
  /** Replaces the intake pipeline. Tests use it to observe what the webhook forwards. */
  readonly onMessage?: (message: InboundMessage) => Promise<void>;
  /** Injected in tests so they can use in-memory stores. */
  readonly store?: CaseStore;
  readonly auth?: AuthStore;
  /** Tests only: a predictable patient login code. */
  readonly generateCode?: () => string;
}

export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.isProduction ? 'info' : 'debug',
      redact: {
        // Credentials and session cookies pass through headers. Redact them at the logger so
        // no future code path can put a token in a log file by accident.
        paths: ['req.headers.authorization', 'req.headers["x-hub-signature-256"]', 'req.headers.cookie'],
        censor: '[redacted]',
      },
    },
    // Meta's payloads are small. A low cap is a cheap defence against a body-size attack on
    // a public endpoint.
    bodyLimit: 1024 * 1024,
    trustProxy: true,
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

  const usingFileStore = config.storePath !== ':memory:' && (deps.store === undefined || deps.auth === undefined);
  if (usingFileStore) mkdirSync(dirname(config.storePath), { recursive: true });
  const store = deps.store ?? new SqliteCaseStore({ path: config.storePath });
  const auth = deps.auth ?? new SqliteAuthStore({ path: config.storePath });

  app.addHook('onClose', async () => {
    if (deps.store === undefined) await store.close();
    if (deps.auth === undefined) await auth.close();
  });

  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request, reply) => {
    request.principal = await resolvePrincipal(request, auth, store);

    // State-changing requests must be JSON. A plain HTML form on another site cannot send
    // `application/json` without a CORS preflight, so this closes the cross-site request
    // forgery route that SameSite cookies leave open in older browsers.
    if (request.method === 'POST' && !(request.headers['content-type'] ?? '').startsWith('application/json')) {
      return reply.code(415).send({ error: 'Send JSON.' });
    }
    return undefined;
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

  const handleInbound = createInboundHandler({ store, provider, whatsapp, log: app.log });

  app.register(whatsappRoutes, {
    settings: config.whatsapp,
    seen: new SeenMessages(),
    onMessage:
      deps.onMessage ??
      (async (message: InboundMessage) => {
        await handleInbound(message);
      }),
  });

  app.register(authRoutes, {
    auth,
    cases: store,
    whatsapp,
    secureCookies: config.isProduction,
    logLoginCodes: !config.isProduction,
    ...(deps.generateCode === undefined ? {} : { generateCode: deps.generateCode }),
  });
  app.register(caseRoutes, { store, auth, whatsapp });
  app.register(patientRoutes, { store, auth, handleInbound });
  app.register(staffRoutes, { auth });

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
