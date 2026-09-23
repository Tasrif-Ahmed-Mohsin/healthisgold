import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@hc/store';

import { buildPriorContext } from '../src/intake/context.ts';

let seq = 0;
function event(type: DomainEvent['type'], data: Record<string, unknown>): DomainEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    caseId: 'case-1',
    seq,
    type,
    at: new Date(2026, 8, 23, 10, seq).toISOString(),
    actor: { kind: 'system', component: 'test' },
    data,
  };
}

describe('rebuilding a case from its events', () => {
  it('accumulates symptoms across messages instead of replacing them', () => {
    // The bug this guards against: a patient reports fever on Monday and vomiting on
    // Tuesday, and the case ends up knowing only about the vomiting.
    const prior = buildPriorContext([
      event('message.received', { text: 'তিন দিন ধরে জ্বর' }),
      event('extraction.completed', { symptoms: [{ code: 'fever', evidence: 'জ্বর' }] }),
      event('message.received', { text: 'এখন বমিও হচ্ছে' }),
      event('extraction.completed', { symptoms: [{ code: 'vomiting', evidence: 'বমি' }] }),
    ]);

    expect(prior.symptoms.map((s) => s.code).sort()).toEqual(['fever', 'vomiting']);
    expect(prior.utterances).toHaveLength(2);
  });

  it('keeps every utterance, so the lexicon still sees an older danger sign', () => {
    const prior = buildPriorContext([
      event('message.received', { text: 'বুকে ব্যথা' }),
      event('extraction.completed', { symptoms: [] }),
      event('message.received', { text: 'ধন্যবাদ' }),
    ]);

    expect(prior.utterances).toEqual(['বুকে ব্যথা', 'ধন্যবাদ']);
  });

  it('does not repeat a symptom reported twice', () => {
    const prior = buildPriorContext([
      event('extraction.completed', { symptoms: [{ code: 'fever', evidence: 'first' }] }),
      event('extraction.completed', { symptoms: [{ code: 'fever', evidence: 'second' }] }),
    ]);

    expect(prior.symptoms).toHaveLength(1);
    expect(prior.symptoms[0]?.evidence).toBe('first');
  });

  it('keeps an age stated once, even when later messages omit it', () => {
    const prior = buildPriorContext([
      event('extraction.completed', { symptoms: [], ageMonths: 540 }),
      event('extraction.completed', { symptoms: [], ageMonths: null }),
    ]);

    expect(prior.ageMonths).toBe(540);
  });

  it('ignores a symptom code outside the safety vocabulary', () => {
    const prior = buildPriorContext([
      event('extraction.completed', { symptoms: [{ code: 'dengue_fever' }, { code: 'fever' }] }),
    ]);

    expect(prior.symptoms.map((s) => s.code)).toEqual(['fever']);
  });

  it('survives malformed event data', () => {
    const prior = buildPriorContext([
      event('extraction.completed', { symptoms: 'not-an-array' }),
      event('extraction.completed', { symptoms: [null, 42, {}, { code: 7 }] }),
      event('message.received', { text: 42 }),
    ]);

    expect(prior.symptoms).toEqual([]);
    expect(prior.utterances).toEqual([]);
  });
});
