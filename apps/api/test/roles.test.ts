/**
 * The permission model, tested from the outside.
 *
 * Every test here talks HTTP, exactly as the web app or an attacker would. Hiding a button in
 * the UI proves nothing; these prove the server refuses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { SqliteAuthStore, SqliteCaseStore, type AuthStore, type CaseStore } from '@hc/store';

import { hashPassword } from '../src/auth/password.ts';
import type { Config } from '../src/config.ts';
import { buildServer } from '../src/server.ts';

const CONFIG: Config = {
  port: 0,
  nodeEnv: 'test',
  isProduction: false,
  storePath: ':memory:',
  whatsapp: null,
  llm: null,
};

const PASSWORD = 'correct horse battery';
const CODE = '424242';

interface World {
  app: FastifyInstance;
  store: CaseStore;
  auth: AuthStore;
  ids: {
    coordinator: string;
    doctor: string;
    admin: string;
    patientA: string;
    patientB: string;
    redCase: string;
    greenCase: string;
    otherCase: string;
  };
}

let world: World;

async function staffCookie(username: string, password = PASSWORD): Promise<string> {
  const response = await world.app.inject({ method: 'POST', url: '/auth/staff/login', payload: { username, password } });
  expect(response.statusCode, `login as ${username}`).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

async function patientCookie(phone: string): Promise<string> {
  await world.app.inject({ method: 'POST', url: '/auth/patient/request-code', payload: { phone } });
  const response = await world.app.inject({ method: 'POST', url: '/auth/patient/verify', payload: { phone, code: CODE } });
  expect(response.statusCode, `patient login ${phone}`).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}

function get(url: string, cookie?: string) {
  return world.app.inject({ method: 'GET', url, ...(cookie === undefined ? {} : { headers: { cookie } }) });
}

function post(url: string, payload: object, cookie?: string) {
  return world.app.inject({ method: 'POST', url, payload, ...(cookie === undefined ? {} : { headers: { cookie } }) });
}

beforeEach(async () => {
  const store = new SqliteCaseStore({ path: ':memory:' });
  const auth = new SqliteAuthStore({ path: ':memory:' });
  const hash = await hashPassword(PASSWORD);

  const coordinator = await auth.createStaff({ username: 'nusrat', displayName: 'Nusrat', role: 'coordinator', bmdcRegNo: null, passwordHash: hash });
  const doctor = await auth.createStaff({ username: 'drarif', displayName: 'Dr Arif', role: 'doctor', bmdcRegNo: 'A-99999', passwordHash: hash });
  const admin = await auth.createStaff({ username: 'admin', displayName: 'Admin', role: 'admin', bmdcRegNo: null, passwordHash: hash });

  const patientA = await store.resolvePatient('whatsapp', '8801720000001', 'Rahim');
  const patientB = await store.resolvePatient('whatsapp', '8801720000002', 'Karim');

  const redCase = await store.openCase(patientA.id);
  await store.applyVerdict(redCase.id, {
    level: 'RED',
    disposition: 'EMERGENCY_REFERRAL_NOW',
    symptomCodes: ['chest_pain', 'sweating'],
    missing: [],
    firedRuleIds: ['cardiac.acs_pattern'],
  });
  await store.append(redCase.id, [
    { type: 'message.received', actor: { kind: 'patient', patientId: patientA.id }, data: { text: 'বুকে ব্যথা আর ঘাম' } },
    { type: 'safety.evaluated', actor: { kind: 'system', component: 'safety-kernel' }, data: { level: 'RED' } },
  ]);

  const greenCase = await store.openCase(patientB.id);
  const otherCase = greenCase;

  const app = buildServer(CONFIG, { store, auth, generateCode: () => CODE });
  world = {
    app,
    store,
    auth,
    ids: {
      coordinator: coordinator.id,
      doctor: doctor.id,
      admin: admin.id,
      patientA: patientA.id,
      patientB: patientB.id,
      redCase: redCase.id,
      greenCase: greenCase.id,
      otherCase: otherCase.id,
    },
  };
});

afterEach(async () => {
  await world.app.close();
  await world.store.close();
  await world.auth.close();
});

describe('staff sign-in', () => {
  it('signs a coordinator in and reports their role', async () => {
    const cookie = await staffCookie('nusrat');
    const me = await get('/auth/me', cookie);

    expect(me.json()).toMatchObject({ kind: 'staff', role: 'coordinator', name: 'Nusrat' });
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const wrongPassword = await post('/auth/staff/login', { username: 'nusrat', password: 'nope-nope-nope' });
    const unknownUser = await post('/auth/staff/login', { username: 'nobody', password: 'nope-nope-nope' });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownUser.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownUser.json());
  });

  it('sets the session cookie httpOnly and SameSite=Strict', async () => {
    const response = await post('/auth/staff/login', { username: 'nusrat', password: PASSWORD });
    const cookie = String(response.headers['set-cookie']);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('ends an existing session the moment an account is deactivated', async () => {
    const coordinator = await staffCookie('nusrat');
    const admin = await staffCookie('admin');

    expect((await get('/cases', coordinator)).statusCode).toBe(200);
    await post(`/staff/${world.ids.coordinator}/active`, { active: false }, admin);

    expect((await get('/cases', coordinator)).statusCode).toBe(401);
    expect((await post('/auth/staff/login', { username: 'nusrat', password: PASSWORD })).statusCode).toBe(401);
  });

  it('signs out', async () => {
    const cookie = await staffCookie('nusrat');
    await post('/auth/logout', {}, cookie);

    expect((await get('/auth/me', cookie)).statusCode).toBe(401);
  });
});

describe('patient sign-in by WhatsApp code', () => {
  it('signs a patient in with the code, however they type their number', async () => {
    const cookie = await patientCookie('01720-000001');
    const me = await get('/auth/me', cookie);

    expect(me.json()).toMatchObject({ kind: 'patient', id: world.ids.patientA });
  });

  it('answers an unknown number exactly as it answers a known one', async () => {
    const known = await post('/auth/patient/request-code', { phone: '01720000001' });
    const unknown = await post('/auth/patient/request-code', { phone: '01799999999' });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(Object.keys(known.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    // ...and there is no code for the unknown number to be verified against.
    expect((await post('/auth/patient/verify', { phone: '01799999999', code: CODE })).statusCode).toBe(400);
  });

  it('locks the code after five wrong guesses', async () => {
    await post('/auth/patient/request-code', { phone: '01720000001' });
    for (let i = 0; i < 5; i += 1) {
      expect((await post('/auth/patient/verify', { phone: '01720000001', code: '000000' })).statusCode).toBe(400);
    }

    // Even the right code is refused now; a new one must be requested.
    expect((await post('/auth/patient/verify', { phone: '01720000001', code: CODE })).statusCode).toBe(429);
  });

  it('rejects something that is not a Bangladeshi mobile number', async () => {
    expect((await post('/auth/patient/request-code', { phone: '12345' })).statusCode).toBe(400);
  });
});

describe('who can read cases', () => {
  it('refuses anyone signed out', async () => {
    expect((await get('/cases')).statusCode).toBe(401);
  });

  it('refuses a patient the staff queue', async () => {
    expect((await get('/cases', await patientCookie('01720000001'))).statusCode).toBe(403);
  });

  it('refuses an admin — running the system does not require reading records', async () => {
    const admin = await staffCookie('admin');

    expect((await get('/cases', admin)).statusCode).toBe(403);
    expect((await get(`/cases/${world.ids.redCase}`, admin)).statusCode).toBe(403);
  });

  it('records every time staff open a case', async () => {
    const cookie = await staffCookie('nusrat');
    await get(`/cases/${world.ids.redCase}`, cookie);

    const log = await world.auth.accessLogFor(world.ids.redCase);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ principalId: world.ids.coordinator, action: 'case.viewed' });
  });
});

describe('the clinical line', () => {
  it('refuses a coordinator who tries to sign an assessment', async () => {
    const cookie = await staffCookie('nusrat');
    const response = await post(`/cases/${world.ids.redCase}/assessment`, { assessment: 'x', plan: 'y' }, cookie);

    expect(response.statusCode).toBe(403);
  });

  it('lets a doctor sign, stamped with their BMDC number', async () => {
    const cookie = await staffCookie('drarif');
    const response = await post(
      `/cases/${world.ids.redCase}/assessment`,
      { assessment: 'Possible ACS.', plan: 'ECG and troponin at the facility.', patientAdvice: 'Go to the hospital now.' },
      cookie,
    );

    expect(response.statusCode).toBe(200);
    const signed = (await world.store.eventsFor(world.ids.redCase)).find((e) => e.type === 'assessment.signed');
    expect(signed?.data['bmdcRegNo']).toBe('A-99999');
    expect(signed?.actor).toMatchObject({ kind: 'staff', staffId: world.ids.doctor, role: 'doctor' });
  });

  it('will not let a coordinator close an urgent case no doctor has signed', async () => {
    const coordinator = await staffCookie('nusrat');

    const refused = await post(`/cases/${world.ids.redCase}/close`, { reason: 'patient feels better' }, coordinator);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/Route it to a doctor/);

    const doctor = await staffCookie('drarif');
    await post(`/cases/${world.ids.redCase}/assessment`, { assessment: 'a', plan: 'b' }, doctor);

    expect((await post(`/cases/${world.ids.redCase}/close`, { reason: 'seen at facility' }, coordinator)).statusCode).toBe(200);
  });

  it('lets a coordinator close a GREEN case without a doctor', async () => {
    const cookie = await staffCookie('nusrat');

    expect((await post(`/cases/${world.ids.greenCase}/close`, { reason: 'resolved' }, cookie)).statusCode).toBe(200);
  });

  it('routes a case to a named doctor', async () => {
    const cookie = await staffCookie('nusrat');
    await post(`/cases/${world.ids.redCase}/route`, { reason: 'chest pain, needs review', doctorId: world.ids.doctor }, cookie);

    const routed = await world.store.getCase(world.ids.redCase);
    expect(routed?.status).toBe('with_doctor');
    expect(routed?.assignedDoctorId).toBe(world.ids.doctor);
  });
});

describe('what a coordinator may say to a patient', () => {
  it.each([
    ['English reassurance', 'This is not serious, rest at home.'],
    ['Bangla reassurance', 'চিন্তার কিছু নেই, বাসায় বিশ্রাম নিন।'],
    ['a dose', 'Take paracetamol 500 mg now.'],
    ['a Bangladeshi prescription pattern', 'Napa 1+0+1 খাবেন'],
    ['Bangla prescribing', 'দিনে ৩ বার ট্যাবলেট খাবেন'],
  ])('blocks %s', async (_label, text) => {
    const cookie = await staffCookie('nusrat');
    const response = await post(`/cases/${world.ids.redCase}/questions`, { text }, cookie);

    expect(response.statusCode).toBe(422);
    expect(await world.store.eventsFor(world.ids.redCase)).not.toContainEqual(expect.objectContaining({ type: 'question.sent' }));
  });

  it('allows an ordinary question and moves the case to waiting on the patient', async () => {
    const cookie = await staffCookie('nusrat');
    const response = await post(`/cases/${world.ids.greenCase}/questions`, { text: 'কতদিন ধরে জ্বর? How many days?' }, cookie);

    expect(response.statusCode).toBe(200);
    expect((await world.store.getCase(world.ids.greenCase))?.status).toBe('awaiting_patient');
  });

  it('does not restrict what a doctor says', async () => {
    const cookie = await staffCookie('drarif');
    const response = await post(`/cases/${world.ids.greenCase}/questions`, { text: 'This is not serious. Take paracetamol 500 mg.' }, cookie);

    expect(response.statusCode).toBe(200);
  });
});

describe('the patient view', () => {
  it('hides internal notes, triage output and the clinical assessment', async () => {
    const coordinator = await staffCookie('nusrat');
    const doctor = await staffCookie('drarif');
    await post(`/cases/${world.ids.redCase}/notes`, { text: 'INTERNAL: patient sounded anxious' }, coordinator);
    await post(
      `/cases/${world.ids.redCase}/assessment`,
      { assessment: 'CLINICAL: probable ACS', plan: 'PLAN: troponin', patientAdvice: 'Please go to the hospital now.' },
      doctor,
    );

    const patient = await patientCookie('01720000001');
    const response = await get(`/me/cases/${world.ids.redCase}`, patient);
    const body = JSON.stringify(response.json());

    expect(response.statusCode).toBe(200);
    expect(body).toContain('Please go to the hospital now.');
    expect(body).toContain('বুকে ব্যথা আর ঘাম');
    for (const hidden of ['INTERNAL', 'CLINICAL', 'PLAN:', 'RED', 'cardiac', 'safety-kernel']) {
      expect(body, `patient view must not contain "${hidden}"`).not.toContain(hidden);
    }
  });

  it("returns 404, not 403, for someone else's case", async () => {
    const patient = await patientCookie('01720000001');

    expect((await get(`/me/cases/${world.ids.otherCase}`, patient)).statusCode).toBe(404);
  });

  it('lists only their own cases', async () => {
    const patient = await patientCookie('01720000001');
    const ids = (await get('/me/cases', patient)).json().cases.map((c: { id: string }) => c.id);

    expect(ids).toEqual([world.ids.redCase]);
  });

  it('keeps an urgent case urgent when a rule re-fires on the accumulated history', async () => {
    // "বুকে ব্যথা আর ঘাম" is still part of this case, so the cardiac rule fires again on the
    // accumulated words even though the new message is harmless.
    const patient = await patientCookie('01720000001');
    const response = await post('/me/messages', { text: 'ধন্যবাদ' }, patient);

    expect((await world.store.getCase(response.json().caseId))?.level).toBe('RED');
  });

  it('never lets automation lower a case that only a model had called urgent', async () => {
    // Patient B's case is RED purely because a model once said so — no rule, no danger words.
    // A later harmless message evaluates GREEN on its own. The case must stay RED: lowering
    // urgency is a clinical judgement, and no automated step is allowed to make it.
    await world.store.applyVerdict(world.ids.greenCase, {
      level: 'RED',
      disposition: 'EMERGENCY_REFERRAL_NOW',
      symptomCodes: [],
      missing: [],
      firedRuleIds: [],
    });

    const patient = await patientCookie('01720000002');
    const response = await post('/me/messages', { text: 'ধন্যবাদ, এখন একটু ভালো লাগছে' }, patient);

    const updated = await world.store.getCase(response.json().caseId);
    expect(response.json().caseId).toBe(world.ids.greenCase);
    expect(updated?.level).toBe('RED');
    expect(updated?.disposition).toBe('EMERGENCY_REFERRAL_NOW');

    const evaluation = (await world.store.eventsFor(world.ids.greenCase)).filter((e) => e.type === 'safety.evaluated').at(-1);
    expect(evaluation?.data['level']).toBe('GREEN');
    expect(evaluation?.data['caseLevel']).toBe('RED');
    expect(evaluation?.data['heldAbove']).toBe(true);
  });

  it('accepts a message from the portal and runs it through the same intake', async () => {
    const patient = await patientCookie('01720000001');
    const response = await post('/me/messages', { text: 'এখন শ্বাসকষ্টও হচ্ছে' }, patient);

    expect(response.statusCode).toBe(200);
    const events = await world.store.eventsFor(response.json().caseId);
    const received = events.filter((e) => e.type === 'message.received').at(-1);
    expect(received?.data['channel']).toBe('web');
    // No model is configured in tests, so this proves the lexicon channel alone evaluated it.
    expect(events.some((e) => e.type === 'safety.evaluated')).toBe(true);
  });
});

describe('account management', () => {
  it('lets an admin create a doctor, and requires the BMDC number', async () => {
    const admin = await staffCookie('admin');

    const missing = await post('/staff', { username: 'drx', displayName: 'Dr X', role: 'doctor', password: 'long-enough-pw' }, admin);
    expect(missing.statusCode).toBe(400);

    const created = await post(
      '/staff',
      { username: 'drx', displayName: 'Dr X', role: 'doctor', password: 'long-enough-pw', bmdcRegNo: 'A-12345' },
      admin,
    );
    expect(created.statusCode).toBe(200);
  });

  it('refuses account management to anyone but an admin', async () => {
    const coordinator = await staffCookie('nusrat');

    expect((await get('/staff', coordinator)).statusCode).toBe(403);
    expect((await post('/staff', { username: 'x' }, coordinator)).statusCode).toBe(403);
  });
});

describe('request hygiene', () => {
  it('refuses a state-changing request that is not JSON', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: '/auth/staff/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=nusrat&password=x',
    });

    expect(response.statusCode).toBe(415);
  });
});
