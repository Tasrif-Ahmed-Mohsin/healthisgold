/**
 * Every numeric cut-off the kernel uses, named and in one place.
 *
 * These are pulled out of the rules so that a clinician reviewing this system can audit
 * the numbers without reading any logic, and so a partner organisation can justify a local
 * deviation as a single reviewed change rather than a hunt through conditionals.
 */

/** WHO IMCI fast-breathing thresholds, in breaths per minute, by age band. */
export const FAST_BREATHING = {
  /** Under 2 months. */
  neonatal: 60,
  /** 2 to 11 months. */
  infant: 50,
  /** 12 to 59 months. */
  child: 40,
  /** 5 years and over, including adults. */
  older: 30,
} as const;

/** Returns the fast-breathing threshold for an age in months. */
export function fastBreathingThreshold(ageMonths: number): number {
  if (ageMonths < 2) return FAST_BREATHING.neonatal;
  if (ageMonths < 12) return FAST_BREATHING.infant;
  if (ageMonths < 60) return FAST_BREATHING.child;
  return FAST_BREATHING.older;
}

export const SPO2 = {
  /** Below this, oxygen is indicated and the patient needs a facility. */
  hypoxic: 90,
  /** Below this, treat as immediately life-threatening. */
  critical: 85,
  /** Below this but above `hypoxic` — concerning, not yet an emergency on its own. */
  borderline: 94,
} as const;

export const TEMPERATURE_C = {
  /** IMCI treats any fever in a young infant as a sign of severe illness. */
  youngInfantFever: 37.5,
  fever: 38,
  hyperpyrexia: 40,
  /** Hypothermia in a young infant is as dangerous as fever. */
  youngInfantHypothermia: 35.5,
} as const;

export const BLOOD_PRESSURE = {
  /** Adult systolic below this suggests shock. */
  adultHypotensionSystolic: 90,
  severeHypertensionSystolic: 180,
  severeHypertensionDiastolic: 120,
  /** In pregnancy the threshold for concern is far lower — pre-eclampsia. */
  pregnancyHypertensionSystolic: 140,
  pregnancyHypertensionDiastolic: 90,
} as const;

export const GLUCOSE_MG_DL = {
  /** Clinically significant hypoglycaemia (3.0 mmol/L). */
  hypoglycaemia: 54,
  /** Severe hypoglycaemia (2.2 mmol/L). */
  severeHypoglycaemia: 40,
  /** Suggests a hyperglycaemic crisis when paired with symptoms. */
  crisisHyperglycaemia: 400,
} as const;

export const HEART_RATE = {
  adultTachycardia: 120,
  adultBradycardia: 45,
} as const;

/** Age in months below which neonatal / young-infant rules apply. */
export const YOUNG_INFANT_MONTHS = 2;

/** Age in years at or above which undifferentiated chest pain is treated as cardiac. */
export const CARDIAC_CHEST_PAIN_AGE_YEARS = 40;

/** Age in months below which paediatric dehydration rules apply (under 5 years). */
export const UNDER_FIVE_MONTHS = 60;
