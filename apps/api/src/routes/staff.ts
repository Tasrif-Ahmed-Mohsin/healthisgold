/**
 * Account management. Admin only — and admin can do nothing else.
 *
 * An admin creates, deactivates, and resets staff accounts. They cannot open a case: running
 * the system does not require reading anyone's health record, so the role is not given that
 * power. Deactivation signs the person out everywhere immediately.
 */

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { AuthStore, StaffRole } from '@hc/store';

import { hashPassword, passwordProblem } from '../auth/password.ts';
import { requireStaff } from '../auth/session.ts';

export interface StaffRouteOptions extends FastifyPluginOptions {
  readonly auth: AuthStore;
}

const ROLES: readonly StaffRole[] = ['coordinator', 'doctor', 'admin'];

function field(request: FastifyRequest, key: string): unknown {
  return typeof request.body === 'object' && request.body !== null ? (request.body as Record<string, unknown>)[key] : undefined;
}

export function staffRoutes(app: FastifyInstance, options: StaffRouteOptions, done: (error?: Error) => void): void {
  const { auth } = options;

  app.get('/staff', async (request, reply) => {
    if (requireStaff(request, reply, ['admin']) === null) return reply;
    return { staff: await auth.listStaff() };
  });

  app.post('/staff', async (request, reply) => {
    if (requireStaff(request, reply, ['admin']) === null) return reply;

    const username = field(request, 'username');
    const displayName = field(request, 'displayName');
    const role = field(request, 'role');
    const password = field(request, 'password');
    const bmdcRegNo = field(request, 'bmdcRegNo');

    if (typeof username !== 'string' || !/^[a-z0-9._-]{3,40}$/i.test(username)) {
      return reply.code(400).send({ error: 'Username: 3–40 letters, digits, dots, dashes or underscores.' });
    }
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      return reply.code(400).send({ error: 'Enter the person’s name.' });
    }
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      return reply.code(400).send({ error: 'Choose a role.' });
    }
    if (typeof password !== 'string') return reply.code(400).send({ error: 'Set a password.' });
    const weak = passwordProblem(password);
    if (weak !== null) return reply.code(400).send({ error: weak });

    const registration = typeof bmdcRegNo === 'string' && bmdcRegNo.trim() !== '' ? bmdcRegNo.trim() : null;
    if (role === 'doctor' && registration === null) {
      return reply.code(400).send({ error: 'A doctor account needs a BMDC registration number.' });
    }
    if (await auth.findStaffByUsername(username)) {
      return reply.code(409).send({ error: 'That username is taken.' });
    }

    const created = await auth.createStaff({
      username,
      displayName,
      role: role as StaffRole,
      bmdcRegNo: role === 'doctor' ? registration : null,
      passwordHash: await hashPassword(password),
    });
    return { staff: created };
  });

  app.post('/staff/:id/active', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const admin = requireStaff(request, reply, ['admin']);
    if (admin === null) return reply;
    const active = field(request, 'active');
    if (typeof active !== 'boolean') return reply.code(400).send({ error: 'Say whether the account is active.' });
    if (request.params.id === admin.id && !active) {
      return reply.code(400).send({ error: 'You cannot deactivate your own account.' });
    }

    const target = await auth.getStaff(request.params.id);
    if (target === null) return reply.code(404).send({ error: 'No such account.' });

    await auth.setStaffActive(target.id, active);
    if (!active) await auth.deleteSessionsFor('staff', target.id);
    return { ok: true };
  });

  app.post('/staff/:id/password', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (requireStaff(request, reply, ['admin']) === null) return reply;
    const password = field(request, 'password');
    if (typeof password !== 'string') return reply.code(400).send({ error: 'Set a password.' });
    const weak = passwordProblem(password);
    if (weak !== null) return reply.code(400).send({ error: weak });

    const target = await auth.getStaff(request.params.id);
    if (target === null) return reply.code(404).send({ error: 'No such account.' });

    await auth.setStaffPassword(target.id, await hashPassword(password));
    // A reset password should end every existing session, including a stolen one.
    await auth.deleteSessionsFor('staff', target.id);
    return { ok: true };
  });

  done();
}
