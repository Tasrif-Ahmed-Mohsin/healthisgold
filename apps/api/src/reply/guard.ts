/**
 * What a non-doctor may say to a patient.
 *
 * Under the BMDC Act only a registered doctor may diagnose or prescribe, and reassurance is a
 * clinical judgement too — "it's nothing serious" from a coordinator is practising medicine,
 * and it is the sentence most likely to stop a sick person from seeking care. So messages a
 * coordinator writes are checked for reassurance and for prescribing language before they are
 * sent. Doctors are not checked; advising is their job.
 *
 * This is a guard, not a guarantee. A determined person can phrase around any list. What it
 * does is stop the common, well-meant slip — the kind reply typed quickly at the end of a
 * shift — and make the boundary visible at the moment someone is about to cross it. The real
 * controls are training, the audit trail every message leaves, and the doctor's review.
 */

import type { StaffRole } from '@hc/store';

/** Reassurance, in English, Bangla and Banglish. */
export const REASSURANCE_PATTERNS: readonly RegExp[] = [
  /\bnot\s+(?:serious|dangerous|a\s+problem|worrying)\b/i,
  /\bnothing\s+(?:serious|to\s+worry|to\s+be\s+worried)\b/i,
  /\bno\s+need\s+to\s+(?:worry|see\s+a\s+doctor|go\s+to\s+(?:the\s+)?hospital)\b/i,
  /\b(?:you(?:'re|\s+are)\s+(?:fine|ok|okay|alright))\b/i,
  /\bprobably\s+(?:fine|nothing)\b/i,
  /\bdon'?t\s+worry\b/i,
  /চিন্তার\s*কিছু\s*নেই/,
  /চিন্তা\s*করবেন\s*না/,
  /গুরুতর\s*(?:কিছু\s*)?নয়/,
  /ভয়ের\s*কিছু\s*নেই/,
  /হাসপাতালে\s*যাওয়ার\s*দরকার\s*নেই/,
  /\bchinta(?:r)?\s+kichu\s+nei\b/i,
  /\bchinta\s+korben\s+na\b/i,
];

/** Prescribing: doses, dosage forms, and instructions to take medicine. */
export const PRESCRIBING_PATTERNS: readonly RegExp[] = [
  /\b\d+(?:\.\d+)?\s*(?:mg|mcg|ml|g)\b/i,
  /\b(?:tab|tabs|tablet|capsule|cap|syrup|syp|injection|inj)\.?\s+[a-z]/i,
  /\b(?:once|twice|thrice|\d)\s+(?:a|per)\s+day\b/i,
  /\b(?:take|give)\s+(?:\d|one|two|half)\b/i,
  /\b\d\s*\+\s*\d\s*\+\s*\d\b/, // "1+0+1" — the way prescriptions are written in Bangladesh
  /ট্যাবলেট|ক্যাপসুল|সিরাপ|ইনজেকশন/,
  /দিনে\s*[০-৯\d]\s*বার/,
  /খাওয়ার\s*(?:আগে|পরে)/,
];

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkStaffMessage(text: string, role: StaffRole): GuardResult {
  if (text.trim() === '') return { ok: false, reason: 'The message is empty.' };
  if (text.length > 2000) return { ok: false, reason: 'Keep messages to patients under 2000 characters.' };
  if (role === 'doctor') return { ok: true };

  if (REASSURANCE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      ok: false,
      reason:
        'This reads as reassurance, which is a clinical judgement only a doctor may make. ' +
        'Ask a question, or route the case to a doctor instead.',
    };
  }

  if (PRESCRIBING_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      ok: false,
      reason:
        'This reads as a prescription or dosing instruction, which only a registered doctor may give. ' +
        'Route the case to a doctor.',
    };
  }

  return { ok: true };
}
