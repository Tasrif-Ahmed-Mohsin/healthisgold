/**
 * Sessions, and who is on the other end of a request.
 *
 * The session token lives in an httpOnly, SameSite=Strict cookie. httpOnly means script on
 * the page cannot read it, so a cross-site-scripting bug cannot steal a clinician's login.
 * SameSite=Strict means the browser will not attach it to a request another site triggers,
 * which is the main defence against cross-site request forgery here — combined with every
 * state-changing route accepting only JSON, which a plain HTML form cannot send cross-site.
 *
 * The token itself is never stored; the database holds its SHA-256. A leaked database
 * therefore contains no session anyone can reuse.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthStore, CaseStore, PrincipalKind, StaffRole } from '@hc/store';

export const SESSION_COOKIE = 'hc_session';

/** Staff sessions are a working shift; patient sessions are longer because patients log in rarely. */
export const SESSION_LIFETIME_MS: Record<PrincipalKind, number> = {
  staff: 12 * 60 * 60 * 1000,
  patient: 7 * 24 * 60 * 60 * 1000,
};

export type Principal =
  | {
      readonly kind: 'staff';
      readonly id: string;
      readonly role: StaffRole;
      readonly name: string;
      readonly username: string;
      readonly bmdcRegNo: string | null;
    }
  | {
      readonly kind: 'patient';
      readonly id: string;
      readonly name: string | null;
    };

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (header === undefined) return cookies;
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed cookie is not our session; ignore it rather than failing the request.
    }
  }
  return cookies;
}

export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

export async function startSession(
  auth: AuthStore,
  reply: FastifyReply,
  kind: PrincipalKind,
  principalId: string,
  secure: boolean,
): Promise<void> {
  const token = newSessionToken();
  const lifetime = SESSION_LIFETIME_MS[kind];
  await auth.createSession(hashToken(token), {
    principalKind: kind,
    principalId,
    expiresAt: new Date(Date.now() + lifetime).toISOString(),
  });
  reply.header('set-cookie', sessionCookie(token, lifetime, secure));
}

/**
 * Resolves the cookie to a principal, re-reading the account every time.
 *
 * Re-reading rather than trusting what was true at login means deactivating a staff
 * account takes effect on their very next request, not whenever their cookie expires.
 */
export async function resolvePrincipal(request: FastifyRequest, auth: AuthStore, cases: CaseStore): Promise<Principal | null> {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (token === undefined || token === '') return null;

  const session = await auth.getSession(hashToken(token));
  if (session === null) return null;

  if (session.principalKind === 'staff') {
    const staff = await auth.getStaff(session.principalId);
    if (staff === null || !staff.active) return null;
    return {
      kind: 'staff',
      id: staff.id,
      role: staff.role,
      name: staff.displayName,
      username: staff.username,
      bmdcRegNo: staff.bmdcRegNo,
    };
  }

  const patient = await cases.getPatient(session.principalId);
  if (patient === null) return null;
  return { kind: 'patient', id: patient.id, name: patient.displayName };
}

/** Requires a signed-in staff member holding one of the given roles. Sends 401/403 otherwise. */
export function requireStaff(
  request: FastifyRequest,
  reply: FastifyReply,
  roles: readonly StaffRole[],
): Extract<Principal, { kind: 'staff' }> | null {
  const principal = request.principal;
  if (principal === null) {
    void reply.code(401).send({ error: 'Please sign in.' });
    return null;
  }
  if (principal.kind !== 'staff' || !roles.includes(principal.role)) {
    request.log.warn({ principal: principal.kind, url: request.url }, 'forbidden: role not permitted');
    void reply.code(403).send({ error: 'Your role cannot do this.' });
    return null;
  }
  return principal;
}

export function requirePatient(request: FastifyRequest, reply: FastifyReply): Extract<Principal, { kind: 'patient' }> | null {
  const principal = request.principal;
  if (principal === null) {
    void reply.code(401).send({ error: 'Please sign in.' });
    return null;
  }
  if (principal.kind !== 'patient') {
    void reply.code(403).send({ error: 'This page is for patients.' });
    return null;
  }
  return principal;
}
