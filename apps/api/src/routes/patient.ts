/**
 * The patient's view of their own record.
 *
 * A patient sees what was said to them and what they said — their messages, the replies, the
 * questions a health worker asked, and the advice a doctor signed. They do not see internal
 * notes, which exist so staff can think aloud; the triage level or the rules that fired, which
 * are working tools for staff and read as a diagnosis to a frightened person; or the doctor's
 * clinical assessment and plan, which are written for other clinicians. What a doctor wants
 * the patient to know goes in the advice field, deliberately and in plain words.
 *
 * A case belonging to someone else returns 404, not 403. "Forbidden" would confirm that the
 * case exists.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { InboundMessage } from '@hc/channels';
import type { AuthStore, Case, CaseStore, DomainEvent } from '@hc/store';

import { requirePatient } from '../auth/session.ts';
import type { InboundResult } from '../intake/handle.ts';

export interface PatientRouteOptions extends FastifyPluginOptions {
  readonly store: CaseStore;
  readonly auth: AuthStore;
  readonly handleInbound: (message: InboundMessage, knownPatientId?: string) => Promise<InboundResult>;
}

export type PatientStatus = 'reviewing' | 'waiting_for_you' | 'with_doctor' | 'closed';

export interface PatientEntry {
  readonly at: string;
  readonly from: 'you' | 'service' | 'health_worker' | 'doctor';
  readonly text: string;
  readonly name?: string;
  readonly bmdcRegNo?: string;
}

function patientStatus(item: Case): PatientStatus {
  switch (item.status) {
    case 'awaiting_patient':
      return 'waiting_for_you';
    case 'with_doctor':
      return 'with_doctor';
    case 'closed':
      return 'closed';
    default:
      return 'reviewing';
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Projects the full event log down to what the patient is meant to see. Everything else is dropped. */
export function patientTimeline(events: readonly DomainEvent[]): PatientEntry[] {
  const entries: PatientEntry[] = [];

  for (const event of events) {
    const data = event.data;
    switch (event.type) {
      case 'message.received': {
        const said = str(data['text']);
        if (said !== undefined) entries.push({ at: event.at, from: 'you', text: said });
        break;
      }
      case 'reply.sent': {
        const said = str(data['text']);
        if (said !== undefined) entries.push({ at: event.at, from: 'service', text: said });
        break;
      }
      case 'question.sent': {
        const said = str(data['text']);
        const role = event.actor.kind === 'staff' ? event.actor.role : undefined;
        if (said !== undefined) {
          const name = str(data['staffName']);
          entries.push({
            at: event.at,
            from: role === 'doctor' ? 'doctor' : 'health_worker',
            text: said,
            ...(name === undefined ? {} : { name }),
          });
        }
        break;
      }
      case 'assessment.signed': {
        // Only the advice. The assessment and plan are written for clinicians.
        const advice = str(data['patientAdvice']);
        if (advice !== undefined) {
          const name = str(data['staffName']);
          const bmdc = str(data['bmdcRegNo']);
          entries.push({
            at: event.at,
            from: 'doctor',
            text: advice,
            ...(name === undefined ? {} : { name }),
            ...(bmdc === undefined ? {} : { bmdcRegNo: bmdc }),
          });
        }
        break;
      }
      default:
        // note.added, extraction.completed, safety.evaluated, case.routed, reply.suppressed,
        // case.opened, case.closed: staff-side only.
        break;
    }
  }

  return entries;
}

export function patientRoutes(app: FastifyInstance, options: PatientRouteOptions, done: (error?: Error) => void): void {
  const { store, auth, handleInbound } = options;

  app.get('/me/cases', async (request, reply) => {
    const patient = requirePatient(request, reply);
    if (patient === null) return reply;

    const items = await store.casesForPatient(patient.id, 50);
    return {
      name: patient.name,
      cases: await Promise.all(
        items.map(async (item) => {
          const timeline = patientTimeline(await store.eventsFor(item.id));
          const last = timeline[timeline.length - 1];
          return {
            id: item.id,
            openedAt: item.openedAt,
            updatedAt: item.updatedAt,
            status: patientStatus(item),
            lastMessage: last === undefined ? null : { from: last.from, text: last.text.slice(0, 140) },
            hasDoctorAdvice: timeline.some((entry) => entry.from === 'doctor'),
          };
        }),
      ),
    };
  });

  app.get('/me/cases/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const patient = requirePatient(request, reply);
    if (patient === null) return reply;

    const found = await store.getCase(request.params.id);
    if (found === null || found.patientId !== patient.id) return reply.code(404).send({ error: 'Not found.' });

    await auth.logAccess({ principalKind: 'patient', principalId: patient.id, caseId: found.id, action: 'case.viewed' });

    return {
      id: found.id,
      openedAt: found.openedAt,
      status: patientStatus(found),
      timeline: patientTimeline(await store.eventsFor(found.id)),
    };
  });

  /** A message typed in the portal. It takes exactly the path a WhatsApp message takes. */
  app.post('/me/messages', async (request, reply) => {
    const patient = requirePatient(request, reply);
    if (patient === null) return reply;

    const raw = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>)['text'] : undefined;
    const said = typeof raw === 'string' ? raw.trim() : '';
    if (said === '') return reply.code(400).send({ error: 'Write your message first.' });
    if (said.length > 2000) return reply.code(400).send({ error: 'Please keep it under 2000 characters.' });

    const result = await handleInbound(
      {
        channel: 'web',
        senderRef: patient.id,
        externalId: `web-${randomUUID()}`,
        receivedAt: new Date().toISOString(),
        parts: [{ kind: 'text', text: said }],
      },
      patient.id,
    );

    return { caseId: result.caseId };
  });

  done();
}
