import { describe, expect, it } from 'vitest';

import { validateExtraction } from '../src/intake/extract.ts';

describe('validating model output', () => {
  it('accepts a well-formed extraction', () => {
    const result = validateExtraction(
      JSON.stringify({
        symptoms: [{ code: 'fever', evidence: 'জ্বর' }, { code: 'chest_pain', evidence: 'buke betha' }],
        durationHours: 72,
        ageMonths: 540,
        pregnant: false,
        missing: ['temperature'],
        suggestedUrgency: 'YELLOW',
        language: 'mixed',
      }),
    );

    expect(result.symptoms.map((s) => s.code)).toEqual(['fever', 'chest_pain']);
    expect(result.durationHours).toBe(72);
    expect(result.ageMonths).toBe(540);
    expect(result.pregnant).toBe(false);
    expect(result.suggestedUrgency).toBe('YELLOW');
  });

  it('rejects a code the model invented instead of passing it through', () => {
    const result = validateExtraction(
      JSON.stringify({ symptoms: [{ code: 'fever' }, { code: 'dengue_fever' }, { code: 'myocardial_infarction' }] }),
    );

    expect(result.symptoms.map((s) => s.code)).toEqual(['fever']);
    expect(result.rejected).toEqual(['dengue_fever', 'myocardial_infarction']);
  });

  it('ignores an urgency outside the defined levels', () => {
    const result = validateExtraction(JSON.stringify({ symptoms: [], suggestedUrgency: 'CRITICAL' }));

    expect(result.suggestedUrgency).toBeUndefined();
  });

  it('returns an empty extraction rather than throwing on malformed JSON', () => {
    for (const bad of ['', 'not json', '{"symptoms":', '[]', 'null', '{"symptoms": "fever"}']) {
      expect(() => validateExtraction(bad)).not.toThrow();
      expect(validateExtraction(bad).symptoms).toEqual([]);
    }
  });

  it('drops nonsensical numbers instead of trusting them', () => {
    const result = validateExtraction(
      JSON.stringify({ symptoms: [], durationHours: -5, ageMonths: 'forty' }),
    );

    expect(result.durationHours).toBeUndefined();
    expect(result.ageMonths).toBeUndefined();
  });

  it('survives symptom entries that are not objects', () => {
    const result = validateExtraction(JSON.stringify({ symptoms: ['fever', null, 42, { code: 'headache' }] }));

    expect(result.symptoms.map((s) => s.code)).toEqual(['headache']);
  });
});
