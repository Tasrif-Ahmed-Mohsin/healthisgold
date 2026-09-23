import { describe, expect, it } from 'vitest';

import type { ClinicalSnapshot, SymptomObservation } from '../src/domain/snapshot.js';
import { emptySnapshot } from '../src/domain/snapshot.js';
import { allowsAutomatedReply, evaluateSafety } from '../src/safety/kernel.js';
import { findLexiconHits } from '../src/safety/lexicon.js';

function snapshot(overrides: Partial<ClinicalSnapshot> = {}): ClinicalSnapshot {
  return { ...emptySnapshot(), ...overrides };
}

function coded(...codes: SymptomObservation['code'][]): SymptomObservation[] {
  return codes.map((code) => ({ code }));
}

function firedIds(verdict: { firedRules: readonly { id: string }[] }): string[] {
  return verdict.firedRules.map((rule) => rule.id);
}

describe('kernel invariants', () => {
  it('returns GREEN and a review requirement for an empty snapshot', () => {
    const verdict = evaluateSafety(snapshot());

    expect(verdict.level).toBe('GREEN');
    expect(verdict.disposition).toBe('COORDINATOR_REVIEW');
    expect(verdict.firedRules).toEqual([]);
    expect(verdict.requiresHumanReview).toBe(true);
  });

  it('always requires human review, whatever the level', () => {
    const cases = [
      snapshot(),
      snapshot({ symptoms: coded('fever') }),
      snapshot({ vitals: { consciousness: 'unresponsive' } }),
    ];

    for (const input of cases) {
      expect(evaluateSafety(input).requiresHumanReview).toBe(true);
    }
  });

  it('overrides a GREEN model suggestion when a rule fires', () => {
    const verdict = evaluateSafety(
      snapshot({
        patient: { ageMonths: 55 * 12 },
        symptoms: coded('chest_pain', 'sweating'),
      }),
      { aiSuggestion: 'GREEN' },
    );

    expect(verdict.level).toBe('RED');
    expect(verdict.aiSuggestion).toBe('GREEN');
    expect(verdict.escalatedFromAi).toBe(true);
    expect(firedIds(verdict)).toContain('cardiac.acs_pattern');
  });

  it('lets a model raise the level when no rule fires', () => {
    const verdict = evaluateSafety(snapshot(), { aiSuggestion: 'RED' });

    expect(verdict.level).toBe('RED');
    expect(verdict.escalatedFromAi).toBe(false);
    expect(verdict.firedRules).toEqual([]);
  });

  it('records the kernel version so a verdict can be replayed later', () => {
    expect(evaluateSafety(snapshot()).kernelVersion).toMatch(/^\d{4}\.\d{2}\.\d+$/);
  });
});

describe('extraction-independent detection', () => {
  it('fires on the patient\'s own Bangla words when extraction produced nothing', () => {
    const verdict = evaluateSafety(
      snapshot({
        patient: { ageMonths: 60 * 12 },
        symptoms: [],
        rawUtterances: ['বুকে ব্যথা হচ্ছে আর খুব ঘামছে'],
      }),
      { aiSuggestion: 'GREEN' },
    );

    expect(verdict.level).toBe('RED');
    expect(firedIds(verdict)).toContain('cardiac.acs_pattern');
  });

  it('reports the codes extraction missed so the model can be measured on real traffic', () => {
    const verdict = evaluateSafety(
      snapshot({ symptoms: [], rawUtterances: ['buke betha ar ghamche'] }),
    );

    expect(verdict.extractionGaps).toContain('chest_pain');
    expect(verdict.extractionGaps).toContain('sweating');
  });

  it('reports no gap when extraction already coded the symptom', () => {
    const verdict = evaluateSafety(
      snapshot({ symptoms: coded('chest_pain'), rawUtterances: ['buke betha'] }),
    );

    expect(verdict.extractionGaps).not.toContain('chest_pain');
  });

  it('matches romanised Banglish as well as Bangla script', () => {
    const bangla = evaluateSafety(snapshot({ rawUtterances: ['খিঁচুনি হয়েছে'] }));
    const banglish = evaluateSafety(snapshot({ rawUtterances: ['khichuni hoyeche'] }));

    expect(firedIds(bangla)).toContain('neuro.convulsion');
    expect(firedIds(banglish)).toContain('neuro.convulsion');
  });
});

describe('lexicon matching', () => {
  it('suppresses an explicitly negated mention', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 60 * 12 }, rawUtterances: ['no chest pain, only mild cough'] }),
    );

    expect(firedIds(verdict)).not.toContain('cardiac.chest_pain_older_adult');
  });

  it('does not let a phrase suppress itself when the phrase contains a negation', () => {
    // "পানি খেতে পারছে না" means "unable to drink" — the trailing না is part of the danger
    // sign, not a denial of it. Suppressing it would silence a core IMCI red flag.
    const hits = findLexiconHits('বাচ্চা পানি খেতে পারছে না');
    const drink = hits.find((hit) => hit.code === 'unable_to_drink');

    expect(drink).toBeDefined();
    expect(drink?.negated).toBe(false);
  });

  it('does not fire a short romanised term inside an unrelated word', () => {
    // "jor" is Bangla for fever; it must not match inside "major".
    const hits = findLexiconHits('the major issue is a sore ankle');

    expect(hits.map((hit) => hit.code)).not.toContain('fever');
  });

  it('matches Bangla despite case suffixes', () => {
    // "জ্বরে" is "জ্বর" (fever) with a locative suffix.
    const hits = findLexiconHits('জ্বরে ভুগছে');

    expect(hits.map((hit) => hit.code)).toContain('fever');
  });
});

describe('age-banded paediatric rules', () => {
  it('does not flag a respiratory rate that is normal for a newborn', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 1 }, vitals: { respiratoryRate: 55 } }),
    );

    expect(firedIds(verdict)).not.toContain('resp.fast_breathing');
    expect(verdict.level).toBe('GREEN');
  });

  it('flags the same respiratory rate in a two-year-old', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 24 }, vitals: { respiratoryRate: 55 } }),
    );

    expect(firedIds(verdict)).toContain('resp.fast_breathing');
    expect(verdict.level).toBe('RED');
  });

  it('treats any fever in an infant under two months as urgent', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 1 }, vitals: { temperatureC: 37.8 } }),
    );

    expect(firedIds(verdict)).toContain('paeds.young_infant_fever');
    expect(verdict.level).toBe('RED');
  });

  it('does not apply the infant fever rule to an older child at the same temperature', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 36 }, vitals: { temperatureC: 37.8 } }),
    );

    expect(firedIds(verdict)).not.toContain('paeds.young_infant_fever');
  });
});

describe('vitals thresholds', () => {
  it.each([
    [84, 'BLACK', 'resp.critical_hypoxia'],
    [88, 'RED', 'resp.hypoxia'],
    [92, 'YELLOW', 'resp.borderline_saturation'],
  ])('maps SpO2 %i to %s', (spo2, level, ruleId) => {
    const verdict = evaluateSafety(snapshot({ vitals: { spo2 } }));

    expect(verdict.level).toBe(level);
    expect(firedIds(verdict)).toEqual([ruleId]);
  });

  it('leaves a normal saturation alone', () => {
    const verdict = evaluateSafety(snapshot({ vitals: { spo2: 97 } }));

    expect(verdict.level).toBe('GREEN');
    expect(verdict.firedRules).toEqual([]);
  });

  it('does not treat an absent vital as a normal one', () => {
    const withoutVitals = evaluateSafety(snapshot({ symptoms: coded('breathlessness') }));
    const withVitals = evaluateSafety(
      snapshot({ symptoms: coded('breathlessness'), vitals: { spo2: 98, respiratoryRate: 16 } }),
    );

    expect(firedIds(withoutVitals)).toContain('resp.breathlessness');
    expect(firedIds(withVitals)).not.toContain('resp.breathlessness');
  });
});

describe('obstetric rules', () => {
  it('treats bleeding in pregnancy as an emergency', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 27 * 12, pregnant: true }, symptoms: coded('vaginal_bleeding') }),
    );

    expect(verdict.level).toBe('RED');
    expect(verdict.disposition).toBe('EMERGENCY_REFERRAL_NOW');
  });

  it('does not apply pregnancy rules when the patient is not pregnant', () => {
    const verdict = evaluateSafety(
      snapshot({ patient: { ageMonths: 27 * 12, pregnant: false }, symptoms: coded('vaginal_bleeding') }),
    );

    expect(firedIds(verdict)).not.toContain('obs.bleeding_in_pregnancy');
  });
});

describe('mental health routing', () => {
  it('blocks every automated reply on a suicidal-ideation case', () => {
    const verdict = evaluateSafety(snapshot({ rawUtterances: ['ami ar bachte chai na'] }));

    expect(firedIds(verdict)).toContain('mh.suicidal_ideation');
    expect(verdict.disposition).toBe('EMERGENCY_REFERRAL_NOW');
    expect(allowsAutomatedReply(verdict)).toBe(false);
  });

  it('permits an automated acknowledgement on an ordinary case', () => {
    expect(allowsAutomatedReply(evaluateSafety(snapshot({ symptoms: coded('headache') })))).toBe(true);
  });
});
