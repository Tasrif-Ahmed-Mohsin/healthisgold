/**
 * The clinical snapshot: everything the safety kernel is allowed to look at.
 *
 * This is deliberately a plain data structure with no behaviour and no I/O. Whatever
 * produced it — a CHW filling in the console, a voice note transcribed by a model, an
 * OCR'd prescription — the kernel sees the same shape. That is what lets us add channels
 * without touching the part of the system that decides whether someone is in danger.
 */

/**
 * The safety vocabulary: the only symptom codes the red-flag rules reason over.
 *
 * This list is intentionally small. It is not a general symptom ontology — free-text
 * complaints live in `rawUtterances` and structured-but-unsafe-to-act-on detail lives in
 * the case record. A code earns its place here only when a rule needs it, because every
 * code here is something the extraction layer must be evaluated against.
 */
export const SYMPTOM_CODES = [
  // Cardiac / respiratory
  'chest_pain',
  'pain_radiating_arm_jaw',
  'sweating',
  'breathlessness',
  'severe_chest_indrawing',

  // Neurological
  'convulsion',
  'unconscious',
  'facial_droop',
  'arm_weakness',
  'speech_difficulty',
  'neck_stiffness',

  // Bleeding / obstetric
  'severe_bleeding',
  'vaginal_bleeding',
  'reduced_foetal_movement',
  'swelling_face_hands',
  'blurred_vision',

  // Infection / general
  'fever',
  'headache',
  'vomiting',
  'diarrhoea',
  'unable_to_drink',
  'sunken_eyes',
  'reduced_urine',

  // Abdominal
  'abdominal_pain',
  'abdominal_rigidity',

  // Neonatal / paediatric
  'not_feeding',

  // Toxicological
  'snake_bite',
  'poisoning',

  // Mental health
  'suicidal_ideation',
] as const;

export type SymptomCode = (typeof SYMPTOM_CODES)[number];

export function isSymptomCode(value: string): value is SymptomCode {
  return (SYMPTOM_CODES as readonly string[]).includes(value);
}

/**
 * A symptom the extraction layer believes is present.
 *
 * `confidence` is recorded but the kernel deliberately ignores it: a low-confidence
 * red flag is still a red flag. It exists so reviewers can see how sure the model was.
 */
export interface SymptomObservation {
  readonly code: SymptomCode;
  readonly confidence?: number;
  /** The span of patient language this was derived from, for the reviewer to check. */
  readonly evidence?: string;
  readonly durationHours?: number;
}

/** AVPU — assessable by a health worker with no equipment at all. */
export type Consciousness = 'alert' | 'voice' | 'pain' | 'unresponsive';

export interface VitalSigns {
  readonly systolicBp?: number;
  readonly diastolicBp?: number;
  readonly heartRate?: number;
  readonly respiratoryRate?: number;
  readonly temperatureC?: number;
  readonly spo2?: number;
  readonly bloodGlucoseMgDl?: number;
  readonly consciousness?: Consciousness;
}

export type Sex = 'male' | 'female' | 'other' | 'unknown';

export interface PatientContext {
  /**
   * Age in months is the canonical unit. Neonatal and infant rules turn on weeks, and
   * storing years would silently destroy the precision those rules depend on.
   */
  readonly ageMonths?: number;
  readonly sex?: Sex;
  readonly pregnant?: boolean;
  readonly pregnancyWeeks?: number;
  readonly knownConditions?: readonly string[];
  readonly currentMedications?: readonly string[];
}

export interface ClinicalSnapshot {
  readonly patient: PatientContext;
  readonly symptoms: readonly SymptomObservation[];
  /**
   * Verbatim patient or health-worker language, in any script — Bangla, romanised
   * Banglish, English, or a mix. The kernel scans this independently of `symptoms` so a
   * failure in the extraction layer cannot quietly hide a red flag.
   */
  readonly rawUtterances: readonly string[];
  readonly vitals: VitalSigns;
}

export function ageYearsOf(patient: PatientContext): number | undefined {
  return patient.ageMonths === undefined ? undefined : patient.ageMonths / 12;
}

/** An empty snapshot, useful as a base in tests and as the initial state of a new case. */
export function emptySnapshot(): ClinicalSnapshot {
  return { patient: {}, symptoms: [], rawUtterances: [], vitals: {} };
}
