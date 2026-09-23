import { describe, expect, it } from 'vitest';

import { emptySnapshot, evaluateSafety, type ClinicalSnapshot } from '@hc/core';

import { decideReply } from '../src/reply/policy.ts';

function verdictFor(overrides: Partial<ClinicalSnapshot>) {
  return evaluateSafety({ ...emptySnapshot(), ...overrides });
}

describe('automated reply policy', () => {
  it('sends the emergency instruction on an emergency disposition', () => {
    const decision = decideReply(verdictFor({ symptoms: [{ code: 'convulsion' }] }));

    expect(decision.send).toBe(true);
    expect(decision.reason).toBe('emergency');
    expect(decision.text).toContain('হাসপাতাল');
    expect(decision.text).toContain('Do not wait');
  });

  it('sends only an acknowledgement for an ordinary case', () => {
    const decision = decideReply(verdictFor({ symptoms: [{ code: 'headache' }] }));

    expect(decision.send).toBe(true);
    expect(decision.reason).toBe('acknowledgement');
    expect(decision.text).toContain('received your message');
  });

  it('sends nothing at all on a suicidal-ideation case', () => {
    const decision = decideReply(verdictFor({ rawUtterances: ['ami ar bachte chai na'] }));

    expect(decision.send).toBe(false);
    expect(decision.reason).toBe('suppressed-mental-health');
    expect(decision.text).toBe('');
  });

  it('never reassures, in any branch', () => {
    // The single most dangerous sentence this system could emit is one that tells a patient
    // they are fine. No reply may imply it, whatever the triage level.
    const forbidden = [
      /not serious/i,
      /nothing to worry/i,
      /probably fine/i,
      /no need to worry/i,
      /you are fine/i,
      /চিন্তার কিছু নেই/,
      /গুরুতর নয়/,
    ];

    const snapshots: Partial<ClinicalSnapshot>[] = [
      {},
      { symptoms: [{ code: 'headache' }] },
      { symptoms: [{ code: 'fever' }] },
      { symptoms: [{ code: 'chest_pain' }, { code: 'sweating' }] },
      { vitals: { spo2: 84 } },
    ];

    for (const snapshot of snapshots) {
      const { text } = decideReply(verdictFor(snapshot));
      for (const pattern of forbidden) {
        expect(text).not.toMatch(pattern);
      }
    }
  });

  it('never names a condition', () => {
    const forbidden = [/heart attack/i, /stroke/i, /pneumonia/i, /dengue/i, /হার্ট অ্যাটাক/];
    const { text } = decideReply(verdictFor({ symptoms: [{ code: 'chest_pain' }, { code: 'sweating' }] }));

    for (const pattern of forbidden) {
      expect(text).not.toMatch(pattern);
    }
  });

  it('tells an ordinary case when to stop waiting for us', () => {
    // An acknowledgement without safety-netting invites a deteriorating patient to sit and
    // wait for a reply. Naming the trigger to seek care is what makes it safe to send.
    const { text } = decideReply(verdictFor({ symptoms: [{ code: 'headache' }] }));

    expect(text).toContain('If you get worse');
    expect(text).toContain('হাসপাতালে যান');
  });
});
