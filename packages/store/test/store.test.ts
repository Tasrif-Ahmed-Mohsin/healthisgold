import { afterEach, describe, expect, it } from 'vitest';

import { SqliteCaseStore } from '../src/sqlite.js';
import type { CaseStore } from '../src/store.js';

const stores: CaseStore[] = [];

function makeStore(now?: () => Date): CaseStore {
  const store = new SqliteCaseStore({ path: ':memory:', ...(now === undefined ? {} : { now }) });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

const HOUR = 60 * 60 * 1000;

describe('patient identity', () => {
  it('creates a patient on first contact and reuses them afterwards', async () => {
    const store = makeStore();

    const first = await store.resolvePatient('whatsapp', '8801712345678', 'Rahim');
    const second = await store.resolvePatient('whatsapp', '8801712345678');

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('Rahim');
  });

  it('treats the same number on a different channel as a different identity', async () => {
    const store = makeStore();

    const whatsapp = await store.resolvePatient('whatsapp', '8801712345678');
    const sms = await store.resolvePatient('sms', '8801712345678');

    expect(sms.id).not.toBe(whatsapp.id);
  });

  it('does not erase a known display name when a later message carries none', async () => {
    const store = makeStore();

    await store.resolvePatient('whatsapp', '880171', 'Rahim');
    const later = await store.resolvePatient('whatsapp', '880171');

    expect(later.displayName).toBe('Rahim');
  });
});

describe('case continuity', () => {
  it('finds a recent open case so a follow-up message joins the same thread', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const opened = await store.openCase(patient.id);

    const found = await store.findActiveCase(patient.id, 72 * HOUR);

    expect(found?.id).toBe(opened.id);
  });

  it('ignores a stale case so an unrelated illness months later starts fresh', async () => {
    let now = new Date('2026-09-01T10:00:00Z');
    const store = makeStore(() => now);
    const patient = await store.resolvePatient('whatsapp', '880171');
    await store.openCase(patient.id);

    now = new Date('2026-09-20T10:00:00Z');

    expect(await store.findActiveCase(patient.id, 72 * HOUR)).toBeNull();
  });

  it('ignores a closed case however recent', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const opened = await store.openCase(patient.id);
    await store.setStatus(opened.id, 'closed');

    expect(await store.findActiveCase(patient.id, 72 * HOUR)).toBeNull();
  });
});

describe('verdicts and the audit trail', () => {
  it('projects a verdict onto the case', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const opened = await store.openCase(patient.id);

    const updated = await store.applyVerdict(opened.id, {
      level: 'RED',
      disposition: 'EMERGENCY_REFERRAL_NOW',
      symptomCodes: ['chest_pain', 'sweating'],
      missing: ['When did it start?'],
      firedRuleIds: ['cardiac.acs_pattern'],
      ageMonths: 540,
    });

    expect(updated.level).toBe('RED');
    expect(updated.symptomCodes).toEqual(['chest_pain', 'sweating']);
    expect(updated.firedRuleIds).toEqual(['cardiac.acs_pattern']);
    expect((await store.getPatient(patient.id))?.ageMonths).toBe(540);
  });

  it('does not let a later model guess overwrite an age already recorded', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const opened = await store.openCase(patient.id);

    const base = {
      level: 'GREEN',
      disposition: 'COORDINATOR_REVIEW',
      symptomCodes: [],
      missing: [],
      firedRuleIds: [],
    } as const;

    await store.applyVerdict(opened.id, { ...base, ageMonths: 540 });
    await store.applyVerdict(opened.id, { ...base, ageMonths: 12 });

    expect((await store.getPatient(patient.id))?.ageMonths).toBe(540);
  });

  it('keeps events in order with the actor recorded on each', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const opened = await store.openCase(patient.id);

    await store.append(opened.id, [
      { type: 'message.received', actor: { kind: 'patient', patientId: patient.id }, data: { text: 'বুকে ব্যথা' } },
      { type: 'safety.evaluated', actor: { kind: 'system', component: 'safety-kernel' }, data: { level: 'RED' } },
      { type: 'reply.sent', actor: { kind: 'system', component: 'reply-policy' }, data: { reason: 'emergency' } },
    ]);

    const events = await store.eventsFor(opened.id);

    expect(events.map((e) => e.type)).toEqual(['message.received', 'safety.evaluated', 'reply.sent']);
    expect(events[0]?.actor).toEqual({ kind: 'patient', patientId: patient.id });
    expect(events[1]?.actor).toMatchObject({ kind: 'system', component: 'safety-kernel' });
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
  });
});

describe('de-duplication', () => {
  it('accepts a message id once and refuses it thereafter', async () => {
    const store = makeStore();

    expect(await store.markProcessed('wamid.ABC')).toBe(true);
    expect(await store.markProcessed('wamid.ABC')).toBe(false);
  });
});

describe('the queue', () => {
  it('puts more urgent cases first and older cases first within a level', async () => {
    let now = new Date('2026-09-23T10:00:00Z');
    const store = makeStore(() => now);

    const mk = async (ref: string, level: 'GREEN' | 'RED', minutes: number) => {
      now = new Date(`2026-09-23T10:${String(minutes).padStart(2, '0')}:00Z`);
      const patient = await store.resolvePatient('whatsapp', ref);
      const c = await store.openCase(patient.id);
      await store.applyVerdict(c.id, {
        level,
        disposition: level === 'RED' ? 'EMERGENCY_REFERRAL_NOW' : 'COORDINATOR_REVIEW',
        symptomCodes: [],
        missing: [],
        firedRuleIds: [],
      });
      return c.id;
    };

    const greenOld = await mk('1', 'GREEN', 1);
    const redNew = await mk('2', 'RED', 30);
    const redOld = await mk('3', 'RED', 5);

    // Deliberately created out of order: the red case raised last is the newest.
    const queue = await store.queue();

    expect(queue.map((c) => c.id)).toEqual([redOld, redNew, greenOld]);
  });

  it('excludes closed cases', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const opened = await store.openCase(patient.id);
    await store.setStatus(opened.id, 'closed');

    expect(await store.queue()).toEqual([]);
  });
});

describe('history', () => {
  it('returns previous cases so a patient never starts from zero', async () => {
    const store = makeStore();
    const patient = await store.resolvePatient('whatsapp', '880171');
    const first = await store.openCase(patient.id);
    await store.setStatus(first.id, 'closed');
    const second = await store.openCase(patient.id);

    const history = await store.casesForPatient(patient.id);

    expect(history.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
  });
});
