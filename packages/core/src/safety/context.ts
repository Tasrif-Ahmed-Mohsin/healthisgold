/**
 * The evaluation context handed to every red-flag rule.
 *
 * Rules never touch the raw snapshot directly. They ask questions through this object,
 * which unifies the two detection channels — coded symptoms from the extraction layer and
 * direct matches against the patient's own words — behind a single `has()`. A rule author
 * therefore cannot accidentally write a check that only works when extraction succeeded.
 */

import type { ClinicalSnapshot, SymptomCode, VitalSigns } from '../domain/snapshot.js';
import { ageYearsOf } from '../domain/snapshot.js';
import { findLexiconHits, type LexiconHit } from './lexicon.js';

export interface SafetyContext {
  readonly snapshot: ClinicalSnapshot;
  readonly vitals: VitalSigns;
  readonly ageMonths: number | undefined;
  readonly ageYears: number | undefined;
  readonly pregnant: boolean;
  /** Every non-negated lexicon match found in the patient's raw words. */
  readonly textHits: readonly LexiconHit[];

  /** Present via either channel. This is what rules should normally use. */
  has(code: SymptomCode): boolean;
  /** Present because the extraction layer coded it. */
  hasCoded(code: SymptomCode): boolean;
  /**
   * Present in the patient's words but absent from the coded symptoms — an extraction
   * miss. The kernel surfaces these so the extraction layer can be measured against
   * real traffic instead of only against a benchmark.
   */
  hasTextOnly(code: SymptomCode): boolean;

  /** True when the named vitals are all present, so rules can distinguish absent from normal. */
  hasVitals(...keys: readonly (keyof VitalSigns)[]): boolean;
}

export function buildSafetyContext(snapshot: ClinicalSnapshot): SafetyContext {
  const coded = new Set<SymptomCode>(snapshot.symptoms.map((s) => s.code));

  const allHits = snapshot.rawUtterances.flatMap((utterance) => findLexiconHits(utterance));
  const textHits = allHits.filter((hit) => !hit.negated);
  const fromText = new Set<SymptomCode>(textHits.map((hit) => hit.code));

  const ageMonths = snapshot.patient.ageMonths;

  return {
    snapshot,
    vitals: snapshot.vitals,
    ageMonths,
    ageYears: ageYearsOf(snapshot.patient),
    pregnant: snapshot.patient.pregnant === true,
    textHits,

    has: (code) => coded.has(code) || fromText.has(code),
    hasCoded: (code) => coded.has(code),
    hasTextOnly: (code) => fromText.has(code) && !coded.has(code),

    hasVitals: (...keys) => keys.every((key) => snapshot.vitals[key] !== undefined),
  };
}

/** Symptom codes the patient's words mentioned but extraction failed to produce. */
export function extractionGaps(ctx: SafetyContext): SymptomCode[] {
  const gaps = new Set<SymptomCode>();
  for (const hit of ctx.textHits) {
    if (ctx.hasTextOnly(hit.code)) gaps.add(hit.code);
  }
  return [...gaps];
}
