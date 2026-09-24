/**
 * The staff side of a case: reading it, and acting on it.
 *
 * Every permission here is enforced on the server. The web app hides buttons a role cannot
 * use, but that is courtesy, not control — anyone can send a request without the app. So each
 * route names the roles allowed to call it, and the clinical boundaries are checked here too:
 *
 *   - Only a doctor can sign an assessment, and the signature carries their BMDC number.
 *   - A coordinator's message to a patient is checked for reassurance and prescribing.
 *   - A coordinator cannot close a case that is above GREEN until a doctor has signed it off.
 *     Otherwise "close" becomes a way to make an urgent case disappear from the queue without
 *     anyone qualified having looked at it.
 *   - An admin cannot read cases at all.
 *
 * Every read of a case is written to the access log; every action is an event with the
 * staff member as its actor.
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { WhatsAppAdapter } from '@hc/channels';
import type { AuthStore, Case, CaseStatus, CaseStore } from '@hc/store';

import { requireStaff, type Principal } from '../auth/session.ts';
import { deliverToPatient } from '../delivery.ts';
import { checkStaffMessage } from '../reply/guard.ts';

export interface CaseRouteOptions extends FastifyPluginOptions {
  readonly store: CaseStore;
  readonly auth: AuthStore;
  readonly whatsapp: WhatsAppAdapter | null;
}

type Staff = Extract<Principal, { kind: 'staff' }>;

const CLINICAL = ['coordinator', 'doctor'] as const;
const STATUSES: readonly CaseStatus[] = ['open', 'awaiting_patient', 'with_doctor', 'closed'];

function actor(staff: Staff) {
  return { kind: 'staff', staffId: staff.id, role: staff.role } as const;
}

function text(request: FastifyRequest, key: string, max = 4000): string | null {
  const value = typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > max ? null : trimmed;
}

export function caseRoutes(app: FastifyInstance, options: CaseRouteOptions, done: (error?: Error) => void): void {
  const { store, auth, whatsapp } = options;

  async function loadOpenCase(id: string): Promise<{ found: Case } | { status: number; error: string }> {
    const found = await store.getCase(id);
    if (found === null) return { status: 404, error: 'Case not found.' };
    if (found.status === 'closed') return { status: 409, error: 'This case is closed.' };
    return { found };
  }

  async function withNames(items: Case[]) {
    return Promise.all(
      items.map(async (item) => ({
        ...item,
        patient: await store.getPatient(item.patientId),
        assignedDoctor: item.assignedDoctorId === null ? null : ((await auth.getStaff(item.assignedDoctorId))?.displayName ?? null),
      })),
    );
  }

  app.get('/cases', async (request: FastifyRequest<{ Querystring: { status?: string; mine?: string } }>, reply) => {
    const staff = requireStaff(request, reply, CLINICAL);
    if (staff === null) return reply;

    const status = request.query.status;
    const statuses = status !== undefined && (STATUSES as readonly string[]).includes(status) ? [status as CaseStatus] : undefined;
    let items = await store.queue(200, statuses);
    if (request.query.mine === '1') items = items.filter((item) => item.assignedDoctorId === staff.id);

    return { cases: await withNames(items) };
  });

  app.get('/doctors', async (request, reply) => {
    if (requireStaff(request, reply, CLINICAL) === null) return reply;
    const staff = await auth.listStaff();
    return {
      doctors: staff
        .filter((member) => member.role === 'doctor' && member.active)
        .map((member) => ({ id: member.id, name: member.displayName, bmdcRegNo: member.bmdcRegNo })),
    };
  });

  app.get('/cases/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const staff = requireStaff(request, reply, CLINICAL);
    if (staff === null) return reply;

    const found = await store.getCase(request.params.id);
    if (found === null) return reply.code(404).send({ error: 'Case not found.' });

    await auth.logAccess({ principalKind: 'staff', principalId: staff.id, caseId: found.id, action: 'case.viewed' });

    const [patient, events, history, access] = await Promise.all([
      store.getPatient(found.patientId),
      store.eventsFor(found.id),
      store.casesForPatient(found.patientId),
      auth.accessLogFor(found.id),
    ]);

    // Who has opened this record, most recent first. Shown to staff so that access is visible
    // to the people doing it, not only to an auditor after the fact.
    const viewers = new Map<string, string>();
    for (const entry of [...access].reverse()) {
      if (entry.principalKind !== 'staff' || viewers.has(entry.principalId)) continue;
      const member = await auth.getStaff(entry.principalId);
      viewers.set(entry.principalId, `${member?.displayName ?? 'Unknown'} · ${entry.at}`);
    }

    return {
      case: found,
      patient,
      events,
      history: history.filter((item) => item.id !== found.id),
      assignedDoctor: found.assignedDoctorId === null ? null : ((await auth.getStaff(found.assignedDoctorId))?.displayName ?? null),
      viewedBy: [...viewers.values()].slice(0, 10),
    };
  });

  app.post('/cases/:id/notes', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const staff = requireStaff(request, reply, CLINICAL);
    if (staff === null) return reply;
    const note = text(request, 'text');
    if (note === null) return reply.code(400).send({ error: 'Write the note first.' });

    const loaded = await loadOpenCase(request.params.id);
    if (!('found' in loaded)) return reply.code(loaded.status).send({ error: loaded.error });

    await store.append(loaded.found.id, [{ type: 'note.added', actor: actor(staff), data: { text: note, staffName: staff.name } }]);
    return { ok: true };
  });

  app.post('/cases/:id/questions', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const staff = requireStaff(request, reply, CLINICAL);
    if (staff === null) return reply;
    const question = text(request, 'text', 2000);
    if (question === null) return reply.code(400).send({ error: 'Write the question first.' });

    const guard = checkStaffMessage(question, staff.role);
    if (!guard.ok) return reply.code(422).send({ error: guard.reason });

    const loaded = await loadOpenCase(request.params.id);
    if (!('found' in loaded)) return reply.code(loaded.status).send({ error: loaded.error });

    const delivery = await deliverToPatient({ store, whatsapp }, loaded.found.patientId, question);
    await store.append(loaded.found.id, [
      { type: 'question.sent', actor: actor(staff), data: { text: question, staffName: staff.name, ...delivery } },
    ]);
    // A case with a doctor stays with the doctor; otherwise it waits on the patient.
    if (loaded.found.status !== 'with_doctor') await store.setStatus(loaded.found.id, 'awaiting_patient');

    return { ok: true, delivery };
  });

  app.post('/cases/:id/route', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const staff = requireStaff(request, reply, ['coordinator']);
    if (staff === null) return reply;
    const reason = text(request, 'reason', 1000);
    if (reason === null) return reply.code(400).send({ error: 'Say why this needs a doctor.' });

    const doctorId = text(request, 'doctorId', 100);
    if (doctorId !== null) {
      const doctor = await auth.getStaff(doctorId);
      if (doctor === null || doctor.role !== 'doctor' || !doctor.active) {
        return reply.code(400).send({ error: 'That doctor is not available.' });
      }
    }

    const loaded = await loadOpenCase(request.params.id);
    if (!('found' in loaded)) return reply.code(loaded.status).send({ error: loaded.error });

    await store.assignDoctor(loaded.found.id, doctorId);
    await store.setStatus(loaded.found.id, 'with_doctor');
    await store.append(loaded.found.id, [
      {
        type: 'case.routed',
        actor: actor(staff),
        data: {
          reason,
          staffName: staff.name,
          doctorId,
          doctorName: doctorId === null ? null : ((await auth.getStaff(doctorId))?.displayName ?? null),
        },
      },
    ]);
    return { ok: true };
  });

  app.post('/cases/:id/assessment', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const staff = requireStaff(request, reply, ['doctor']);
    if (staff === null) return reply;

    const assessment = text(request, 'assessment');
    const plan = text(request, 'plan');
    const patientAdvice = text(request, 'patientAdvice', 2000);
    if (assessment === null || plan === null) {
      return reply.code(400).send({ error: 'Both the assessment and the plan are required to sign.' });
    }
    if (staff.bmdcRegNo === null) {
      return reply.code(403).send({ error: 'Your account has no BMDC registration number, so you cannot sign.' });
    }

    const loaded = await loadOpenCase(request.params.id);
    if (!('found' in loaded)) return reply.code(loaded.status).send({ error: loaded.error });

    const delivery = patientAdvice === null ? null : await deliverToPatient({ store, whatsapp }, loaded.found.patientId, patientAdvice);

    await store.append(loaded.found.id, [
      {
        type: 'assessment.signed',
        actor: actor(staff),
        data: {
          assessment,
          plan,
          patientAdvice,
          staffName: staff.name,
          bmdcRegNo: staff.bmdcRegNo,
          delivery,
        },
      },
    ]);
    if (loaded.found.assignedDoctorId === null) await store.assignDoctor(loaded.found.id, staff.id);
    if (loaded.found.status !== 'with_doctor') await store.setStatus(loaded.found.id, 'with_doctor');

    return { ok: true, delivery };
  });

  app.post('/cases/:id/close', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const staff = requireStaff(request, reply, CLINICAL);
    if (staff === null) return reply;
    const reason = text(request, 'reason', 1000);
    if (reason === null) return reply.code(400).send({ error: 'Give a reason for closing.' });

    const loaded = await loadOpenCase(request.params.id);
    if (!('found' in loaded)) return reply.code(loaded.status).send({ error: loaded.error });

    if (staff.role === 'coordinator' && loaded.found.level !== 'GREEN') {
      const events = await store.eventsFor(loaded.found.id);
      if (!events.some((event) => event.type === 'assessment.signed')) {
        return reply.code(409).send({
          error: `This case is ${loaded.found.level} and no doctor has signed it off. Route it to a doctor instead of closing it.`,
        });
      }
    }

    await store.append(loaded.found.id, [{ type: 'case.closed', actor: actor(staff), data: { reason, staffName: staff.name } }]);
    await store.setStatus(loaded.found.id, 'closed');
    return { ok: true };
  });

  done();
}
