/**
 * Read endpoints for the coordinator console.
 *
 * These serve patient health data, and the server is currently reachable through a public
 * tunnel. A bearer token is therefore required — not because a shared secret is real
 * authentication, but because the alternative right now is an open endpoint on the public
 * internet serving clinical records.
 *
 * This is a stopgap with a known expiry. Real access control means per-user accounts, the
 * coordinator/doctor role split that BMDC registration requires, and an audit trail of who
 * read which record. Until that exists, one token gates the lot and every holder is
 * indistinguishable in the logs — which is precisely why it must not survive contact with a
 * real patient.
 */

import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { CaseStore } from '@hc/store';

export interface CaseRouteOptions extends FastifyPluginOptions {
  readonly store: CaseStore;
  /** Null disables the endpoints entirely rather than exposing them unprotected. */
  readonly consoleToken: string | null;
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Compare lengths first: timingSafeEqual throws on a mismatch rather than returning false.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function caseRoutes(app: FastifyInstance, options: CaseRouteOptions, done: (error?: Error) => void): void {
  const { store, consoleToken } = options;

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    if (consoleToken === null) {
      return reply.code(503).send({ error: 'Console endpoints are disabled. Set CONSOLE_TOKEN in .env to enable them.' });
    }

    const header = request.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!tokenMatches(provided, consoleToken)) {
      request.log.warn({ ip: request.ip, url: request.url }, 'rejected unauthenticated console request');
      return reply.code(401).send({ error: 'Unauthorized.' });
    }
    return undefined;
  });

  /** The queue: most urgent first, oldest first within a level. */
  app.get('/cases', async (request: FastifyRequest<{ Querystring: { limit?: string } }>) => {
    const limit = Number(request.query.limit ?? '50');
    const cases = await store.queue(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50);

    return {
      cases: await Promise.all(
        cases.map(async (item) => ({
          ...item,
          patient: await store.getPatient(item.patientId),
        })),
      ),
    };
  });

  /** One case in full: the projection, its event history, and the patient's past cases. */
  app.get('/cases/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const found = await store.getCase(request.params.id);
    if (found === null) return reply.code(404).send({ error: 'Case not found.' });

    const [patient, events, history] = await Promise.all([
      store.getPatient(found.patientId),
      store.eventsFor(found.id),
      store.casesForPatient(found.patientId),
    ]);

    return {
      case: found,
      patient,
      events,
      history: history.filter((item) => item.id !== found.id),
    };
  });

  done();
}
