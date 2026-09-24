/**
 * Signing in.
 *
 * Staff use a username and password. Patients never get a password: they sign in with a
 * six-digit code sent to the WhatsApp number they already message us from. Patients are the
 * people least able to manage yet another credential, and the WhatsApp number is already the
 * identity the system knows them by — so proving control of it is the natural login.
 *
 * Two deliberate refusals to be helpful:
 *
 *   - A code request for a number we do not know gets the same response as one we do. Saying
 *     "no record for this number" would let anyone test whether a given person uses a health
 *     service, and that is itself sensitive.
 *   - A failed staff login does not say whether the username or the password was wrong, and
 *     takes the same time either way.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import type { WhatsAppAdapter } from '@hc/channels';
import type { AuthStore, CaseStore } from '@hc/store';

import { DECOY_HASH_PROMISE, verifyPassword } from '../auth/password.ts';
import { maskPhone, normaliseBdPhone } from '../auth/phone.ts';
import { RateLimiter } from '../auth/ratelimit.ts';
import { SESSION_COOKIE, clearedSessionCookie, hashToken, parseCookies, startSession } from '../auth/session.ts';

export interface AuthRouteOptions extends FastifyPluginOptions {
  readonly auth: AuthStore;
  readonly cases: CaseStore;
  readonly whatsapp: WhatsAppAdapter | null;
  readonly secureCookies: boolean;
  /** When true, a patient's login code is also written to the server log. Never in production. */
  readonly logLoginCodes: boolean;
  /** Replaces the random code. Tests only — a predictable code in production is an open door. */
  readonly generateCode?: () => string;
}

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_REQUESTS_PER_HOUR = 5;

function hashCode(phone: string, code: string): string {
  return createHash('sha256').update(`${phone}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function body<T extends Record<string, unknown>>(request: FastifyRequest): Partial<T> {
  return typeof request.body === 'object' && request.body !== null ? (request.body as Partial<T>) : {};
}

export function authRoutes(app: FastifyInstance, options: AuthRouteOptions, done: (error?: Error) => void): void {
  const { auth, cases, whatsapp, secureCookies, logLoginCodes } = options;
  const generateCode = options.generateCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, '0'));

  const staffLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const codeIpLimiter = new RateLimiter(20, 60 * 60 * 1000);

  app.post('/auth/staff/login', async (request, reply) => {
    const { username, password } = body<{ username: string; password: string }>(request);
    if (typeof username !== 'string' || typeof password !== 'string' || username.trim() === '' || password === '') {
      return reply.code(400).send({ error: 'Enter your username and password.' });
    }

    if (!staffLimiter.attempt(`${username.toLowerCase()}|${request.ip}`)) {
      return reply.code(429).send({ error: 'Too many attempts. Wait fifteen minutes and try again.' });
    }

    const staff = await auth.findStaffByUsername(username);
    // Verify against a decoy when the account does not exist, so both failures take the
    // same time and neither reveals which usernames are real.
    const valid = await verifyPassword(password, staff?.passwordHash ?? (await DECOY_HASH_PROMISE));

    if (staff === null || !valid || !staff.active) {
      request.log.warn({ ip: request.ip }, 'failed staff login');
      return reply.code(401).send({ error: 'That username and password do not match an active account.' });
    }

    staffLimiter.reset(`${username.toLowerCase()}|${request.ip}`);
    await startSession(auth, reply, 'staff', staff.id, secureCookies);
    request.log.info({ staffId: staff.id, role: staff.role }, 'staff signed in');
    return { kind: 'staff', role: staff.role, name: staff.displayName };
  });

  app.post('/auth/patient/request-code', async (request, reply) => {
    const { phone: raw } = body<{ phone: string }>(request);
    const phone = typeof raw === 'string' ? normaliseBdPhone(raw) : null;
    if (phone === null) {
      return reply.code(400).send({ error: 'Enter a Bangladeshi mobile number, for example 01712 345678.' });
    }

    if (!codeIpLimiter.attempt(request.ip)) {
      return reply.code(429).send({ error: 'Too many requests. Try again later.' });
    }
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    if ((await auth.countOtpRequestsSince(phone, since)) >= OTP_MAX_REQUESTS_PER_HOUR) {
      return reply.code(429).send({ error: 'Too many codes requested for this number. Try again in an hour.' });
    }

    // The same answer whether or not the number is known — see the module note.
    const generic = { sent: true, maskedPhone: maskPhone(phone) };

    const patient = await cases.findPatientByChannelRef('whatsapp', phone);
    if (patient === null) {
      request.log.info('login code requested for an unknown number');
      return generic;
    }

    const code = generateCode();
    await auth.saveOtp(phone, hashCode(phone, code), new Date(Date.now() + OTP_TTL_MS).toISOString());

    const text = [
      `আপনার লগইন কোড: ${code}`,
      'কোডটি ১০ মিনিট কার্যকর থাকবে। কাউকে জানাবেন না।',
      '',
      `Your login code: ${code}`,
      'It expires in 10 minutes. Do not share it with anyone.',
    ].join('\n');

    if (whatsapp !== null) {
      try {
        await whatsapp.sendText(phone, text);
      } catch (error) {
        // Outside the 24-hour window this free-form message is refused; production needs an
        // approved authentication template for that case. The code still exists, so a
        // developer can complete the flow from the log below.
        request.log.warn({ error: String(error) }, 'login code could not be sent on WhatsApp');
      }
    }

    if (logLoginCodes) {
      request.log.warn({ phone: maskPhone(phone), code }, 'DEVELOPMENT ONLY — patient login code');
    }

    return generic;
  });

  app.post('/auth/patient/verify', async (request, reply) => {
    const { phone: raw, code } = body<{ phone: string; code: string }>(request);
    const phone = typeof raw === 'string' ? normaliseBdPhone(raw) : null;
    if (phone === null || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
      return reply.code(400).send({ error: 'Enter the six-digit code.' });
    }

    const otp = await auth.getOtp(phone);
    if (otp === null || otp.expiresAt <= new Date().toISOString()) {
      return reply.code(400).send({ error: 'That code has expired. Request a new one.' });
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await auth.deleteOtp(phone);
      return reply.code(429).send({ error: 'Too many wrong codes. Request a new one.' });
    }

    if (!sameHash(otp.codeHash, hashCode(phone, code.trim()))) {
      await auth.incrementOtpAttempts(phone);
      return reply.code(400).send({ error: 'That code is not right.' });
    }

    await auth.deleteOtp(phone);
    const patient = await cases.findPatientByChannelRef('whatsapp', phone);
    if (patient === null) return reply.code(400).send({ error: 'That code has expired. Request a new one.' });

    await startSession(auth, reply, 'patient', patient.id, secureCookies);
    request.log.info({ patientId: patient.id }, 'patient signed in');
    return { kind: 'patient', name: patient.displayName };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token !== undefined && token !== '') await auth.deleteSession(hashToken(token));
    reply.header('set-cookie', clearedSessionCookie(secureCookies));
    return { signedOut: true };
  });

  app.get('/auth/me', async (request, reply) => {
    if (request.principal === null) return reply.code(401).send({ error: 'Not signed in.' });
    return request.principal;
  });

  done();
}
