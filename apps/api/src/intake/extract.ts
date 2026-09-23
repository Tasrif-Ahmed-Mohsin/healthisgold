/**
 * Symptom extraction.
 *
 * Turns what a patient wrote into a structured clinical snapshot. Two constraints shape
 * everything here:
 *
 *   1. **The model reports, it does not reason clinically.** It is asked what the patient
 *      said, not what is wrong with them. It may propose an urgency, but that proposal is
 *      advisory — the safety kernel takes the more urgent of it and its own rule floor.
 *   2. **Its output is validated, not trusted.** A model asked for JSON returns almost-JSON
 *      often enough that unchecked parsing is how an invented symptom code reaches a
 *      clinical queue. Codes outside the safety vocabulary are rejected and reported.
 */

import { SYMPTOM_CODES, TRIAGE_LEVELS, isSymptomCode, type SymptomObservation, type TriageLevel } from '@hc/core';
import { renderUntrusted } from '@hc/llm';

export interface Extraction {
  readonly symptoms: readonly SymptomObservation[];
  /** Codes the model invented. Reported rather than dropped — it is a quality signal. */
  readonly rejected: readonly string[];
  readonly durationHours: number | undefined;
  readonly ageMonths: number | undefined;
  readonly pregnant: boolean | undefined;
  /** What the coordinator still needs to ask. */
  readonly missing: readonly string[];
  /** Advisory only. The kernel may raise above this but never falls below its own floor. */
  readonly suggestedUrgency: TriageLevel | undefined;
  readonly language: string | undefined;
}

export function buildExtractionPrompt(patientText: string): { system: string; user: string } {
  const untrusted = renderUntrusted([{ label: 'patient message', content: patientText }]);

  const system = [
    untrusted.guidance,
    '',
    'You extract structured information from what a patient wrote, for a health worker to review.',
    'You do NOT diagnose, name a condition, suggest a cause, or recommend treatment.',
    'Report only what the patient actually said. Never infer a symptom they did not mention.',
    '',
    'The patient may write in Bangla script, romanised Banglish, English, or a mix of all three.',
    'Bangla digits (০-৯) are numbers. Convert durations to hours.',
    '',
    'Return JSON with exactly these keys:',
    '{',
    '  "symptoms": [{"code": "<code>", "evidence": "<the patient\'s own words>"}],',
    '  "durationHours": <number or null>,',
    '  "ageMonths": <number or null, only if the patient stated an age>,',
    '  "pregnant": <true, false, or null>,',
    '  "missing": ["<what a health worker still needs to ask>"],',
    '  "suggestedUrgency": "GREEN" | "YELLOW" | "RED" | "BLACK",',
    '  "language": "bn" | "en" | "mixed"',
    '}',
    '',
    `Allowed symptom codes: ${SYMPTOM_CODES.join(', ')}.`,
    'If something the patient said has no matching code, leave it out of symptoms — do not invent a code.',
    '',
    // Length discipline is a correctness requirement, not a style preference. A long reply
    // can exceed the token cap and be truncated mid-JSON, which parses as nothing at all —
    // a silent empty extraction rather than a visible error. Bangla is token-expensive, so
    // a free-form list in Bangla is the most likely way to hit that ceiling.
    'Keep "missing" to at most 4 items, each under 8 words, written in English.',
    'Keep every "evidence" span to the few words the patient actually used.',
  ].join('\n');

  return { system, user: untrusted.content };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asLevel(value: unknown): TriageLevel | undefined {
  return typeof value === 'string' && (TRIAGE_LEVELS as readonly string[]).includes(value) ? (value as TriageLevel) : undefined;
}

/**
 * Parses and validates the model's reply, or returns null if it was not usable JSON.
 *
 * The null is load-bearing. An unparseable reply and a reply that genuinely found no
 * symptoms both produce an empty extraction, and those are completely different events:
 * one is a fault to surface, the other is a normal result. Collapsing them is how a
 * truncated response comes to look like a healthy patient.
 */
export function parseExtraction(raw: string): Extraction | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const root = asRecord(payload);
  if (root === undefined) return null;

  const symptoms: SymptomObservation[] = [];
  const rejected: string[] = [];

  const rawSymptoms = Array.isArray(root['symptoms']) ? root['symptoms'] : [];
  for (const entry of rawSymptoms) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const code = record['code'];
    if (typeof code !== 'string') continue;
    if (!isSymptomCode(code)) {
      rejected.push(code);
      continue;
    }
    const evidence = record['evidence'];
    symptoms.push({ code, ...(typeof evidence === 'string' ? { evidence } : {}) });
  }

  const missing = Array.isArray(root['missing'])
    ? root['missing'].filter((item): item is string => typeof item === 'string')
    : [];

  const pregnant = root['pregnant'];

  return {
    symptoms,
    rejected,
    durationHours: asNumber(root['durationHours']),
    ageMonths: asNumber(root['ageMonths']),
    pregnant: typeof pregnant === 'boolean' ? pregnant : undefined,
    missing,
    suggestedUrgency: asLevel(root['suggestedUrgency']),
    language: typeof root['language'] === 'string' ? root['language'] : undefined,
  };
}

/** Convenience wrapper: an unusable reply becomes an empty extraction. */
export function validateExtraction(raw: string): Extraction {
  return parseExtraction(raw) ?? emptyExtraction();
}

export { emptyExtraction };

function emptyExtraction(): Extraction {
  return {
    symptoms: [],
    rejected: [],
    durationHours: undefined,
    ageMonths: undefined,
    pregnant: undefined,
    missing: [],
    suggestedUrgency: undefined,
    language: undefined,
  };
}
