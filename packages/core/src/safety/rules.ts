/**
 * The red-flag rule set.
 *
 * Scope note: this is not a diagnostic engine and must never be read as one. Every rule
 * answers one question — "is there a reason this person cannot safely wait in a queue?" —
 * and the only thing it can do about the answer is raise urgency. No rule lowers a triage
 * level, suggests a diagnosis, or recommends a treatment. Those belong to a clinician.
 *
 * Sources are named per rule. Where the guidance offers a range, the more cautious end is
 * taken, because the cost of a false positive here is reviewer time and the cost of a
 * false negative is a person who needed a hospital and did not go.
 */

import type { RedFlagRule } from './rule.js';
import {
  BLOOD_PRESSURE,
  CARDIAC_CHEST_PAIN_AGE_YEARS,
  GLUCOSE_MG_DL,
  HEART_RATE,
  SPO2,
  TEMPERATURE_C,
  UNDER_FIVE_MONTHS,
  YOUNG_INFANT_MONTHS,
  fastBreathingThreshold,
} from './thresholds.js';

export const RED_FLAG_RULES: readonly RedFlagRule[] = [
  // ---------------------------------------------------------------------------
  // Consciousness and neurological
  // ---------------------------------------------------------------------------
  {
    id: 'neuro.unresponsive',
    level: 'BLACK',
    title: 'Unresponsive patient',
    rationale: 'An unresponsive patient cannot protect their airway. This is the highest priority case in the queue.',
    source: 'AVPU scale; WHO Emergency Triage Assessment and Treatment (ETAT) danger signs',
    evaluate: (ctx) => {
      if (ctx.vitals.consciousness === 'unresponsive') {
        return { detail: 'Responds to neither voice nor pain (AVPU: U).', measurements: ['AVPU: unresponsive'] };
      }
      if (ctx.has('unconscious')) {
        return { detail: 'Loss of consciousness reported.', codes: ['unconscious'] };
      }
      return null;
    },
  },
  {
    id: 'neuro.responds_to_pain_only',
    level: 'RED',
    title: 'Reduced consciousness',
    rationale: 'A patient who responds only to pain has a significantly reduced level of consciousness and needs immediate assessment.',
    source: 'AVPU scale; WHO ETAT danger signs',
    evaluate: (ctx) =>
      ctx.vitals.consciousness === 'pain'
        ? { detail: 'Responds to pain but not to voice (AVPU: P).', measurements: ['AVPU: pain'] }
        : null,
  },
  {
    id: 'neuro.convulsion',
    level: 'RED',
    title: 'Convulsion',
    rationale: 'A convulsion is a general danger sign at any age and needs same-day medical assessment regardless of how well the patient now appears.',
    source: 'WHO IMCI general danger signs',
    evaluate: (ctx) => (ctx.has('convulsion') ? { detail: 'Convulsion or seizure reported.', codes: ['convulsion'] } : null),
  },
  {
    id: 'neuro.stroke_fast',
    level: 'RED',
    title: 'Possible stroke (FAST positive)',
    rationale: 'Facial droop, one-sided arm weakness or new speech difficulty may indicate a stroke, where treatment is time-critical.',
    source: 'FAST stroke recognition (face, arm, speech, time)',
    evaluate: (ctx) => {
      const signs = (['facial_droop', 'arm_weakness', 'speech_difficulty'] as const).filter((code) => ctx.has(code));
      if (signs.length === 0) return null;
      return { detail: `FAST sign present: ${signs.join(', ')}. Time of onset must be established.`, codes: signs };
    },
  },
  {
    id: 'neuro.meningitis',
    level: 'RED',
    title: 'Fever with neck stiffness',
    rationale: 'Fever together with neck stiffness may indicate meningitis and needs urgent assessment.',
    source: 'WHO ETAT; standard meningitis red flags',
    evaluate: (ctx) =>
      ctx.has('fever') && ctx.has('neck_stiffness')
        ? { detail: 'Fever reported alongside neck stiffness.', codes: ['fever', 'neck_stiffness'] }
        : null,
  },

  // ---------------------------------------------------------------------------
  // Cardiac and respiratory
  // ---------------------------------------------------------------------------
  {
    id: 'cardiac.acs_pattern',
    level: 'RED',
    title: 'Chest pain with cardiac features',
    rationale: 'Chest pain accompanied by sweating, radiation to the arm or jaw, or breathlessness fits an acute coronary pattern until proven otherwise.',
    source: 'Standard acute coronary syndrome red flags',
    evaluate: (ctx) => {
      if (!ctx.has('chest_pain')) return null;
      const features = (['sweating', 'pain_radiating_arm_jaw', 'breathlessness'] as const).filter((code) => ctx.has(code));
      if (features.length === 0) return null;
      return { detail: `Chest pain with ${features.join(', ')}.`, codes: ['chest_pain', ...features] };
    },
  },
  {
    id: 'cardiac.chest_pain_older_adult',
    level: 'RED',
    title: 'Chest pain in an adult over 40',
    rationale: 'Undifferentiated chest pain in this age group carries enough cardiac risk that it should not wait in a routine queue, even with no other features.',
    source: 'Conservative triage convention for undifferentiated chest pain',
    evaluate: (ctx) => {
      const years = ctx.ageYears;
      if (!ctx.has('chest_pain') || years === undefined || years < CARDIAC_CHEST_PAIN_AGE_YEARS) return null;
      return { detail: `Chest pain reported at age ${Math.floor(years)}.`, codes: ['chest_pain'] };
    },
  },
  {
    id: 'resp.critical_hypoxia',
    level: 'BLACK',
    title: 'Critical hypoxia',
    rationale: 'Oxygen saturation this low is immediately life-threatening.',
    source: `SpO2 below ${SPO2.critical}%`,
    evaluate: (ctx) => {
      const spo2 = ctx.vitals.spo2;
      if (spo2 === undefined || spo2 >= SPO2.critical) return null;
      return { detail: `Oxygen saturation ${spo2}%.`, measurements: [`SpO2 ${spo2}%`] };
    },
  },
  {
    id: 'resp.hypoxia',
    level: 'RED',
    title: 'Hypoxia',
    rationale: 'Oxygen saturation below 90% indicates the patient needs oxygen and a facility that can provide it.',
    source: `SpO2 below ${SPO2.hypoxic}%`,
    evaluate: (ctx) => {
      const spo2 = ctx.vitals.spo2;
      if (spo2 === undefined || spo2 >= SPO2.hypoxic || spo2 < SPO2.critical) return null;
      return { detail: `Oxygen saturation ${spo2}%.`, measurements: [`SpO2 ${spo2}%`] };
    },
  },
  {
    id: 'resp.borderline_saturation',
    level: 'YELLOW',
    title: 'Borderline oxygen saturation',
    rationale: 'Saturation below 94% is outside the normal range and warrants a same-day look, particularly with any respiratory complaint.',
    source: `SpO2 below ${SPO2.borderline}%`,
    evaluate: (ctx) => {
      const spo2 = ctx.vitals.spo2;
      if (spo2 === undefined || spo2 >= SPO2.borderline || spo2 < SPO2.hypoxic) return null;
      return { detail: `Oxygen saturation ${spo2}%.`, measurements: [`SpO2 ${spo2}%`] };
    },
  },
  {
    id: 'resp.fast_breathing',
    level: 'RED',
    title: 'Fast breathing for age',
    rationale: 'Respiratory rate above the IMCI threshold for the patient\'s age is a pneumonia danger sign, and the threshold is much higher in infants than adults.',
    source: 'WHO IMCI fast-breathing thresholds',
    evaluate: (ctx) => {
      const rate = ctx.vitals.respiratoryRate;
      const ageMonths = ctx.ageMonths;
      if (rate === undefined || ageMonths === undefined) return null;
      const threshold = fastBreathingThreshold(ageMonths);
      if (rate < threshold) return null;
      return {
        detail: `Respiratory rate ${rate}/min against an age threshold of ${threshold}/min.`,
        measurements: [`Respiratory rate ${rate}/min`, `Age ${ageMonths} months`],
      };
    },
  },
  {
    id: 'resp.chest_indrawing',
    level: 'RED',
    title: 'Severe chest indrawing',
    rationale: 'Severe chest indrawing is a sign of severe pneumonia and requires referral.',
    source: 'WHO IMCI severe pneumonia criteria',
    evaluate: (ctx) =>
      ctx.has('severe_chest_indrawing')
        ? { detail: 'Severe chest indrawing observed.', codes: ['severe_chest_indrawing'] }
        : null,
  },
  {
    id: 'resp.breathlessness',
    level: 'YELLOW',
    title: 'Breathlessness reported',
    rationale: 'Breathlessness with no measured vitals cannot be safely left in a routine queue — at minimum someone should measure saturation and respiratory rate.',
    source: 'Conservative floor for an unmeasured respiratory complaint',
    evaluate: (ctx) => {
      if (!ctx.has('breathlessness')) return null;
      if (ctx.hasVitals('spo2', 'respiratoryRate')) return null;
      return { detail: 'Breathlessness reported with no oxygen saturation or respiratory rate recorded.', codes: ['breathlessness'] };
    },
  },

  // ---------------------------------------------------------------------------
  // Circulation and metabolic
  // ---------------------------------------------------------------------------
  {
    id: 'circ.adult_hypotension',
    level: 'RED',
    title: 'Low blood pressure in an adult',
    rationale: 'Systolic pressure below 90 mmHg in an adult suggests shock.',
    source: `Adult systolic below ${BLOOD_PRESSURE.adultHypotensionSystolic} mmHg`,
    evaluate: (ctx) => {
      const systolic = ctx.vitals.systolicBp;
      const years = ctx.ageYears;
      if (systolic === undefined || years === undefined || years < 18) return null;
      if (systolic >= BLOOD_PRESSURE.adultHypotensionSystolic) return null;
      return { detail: `Systolic blood pressure ${systolic} mmHg.`, measurements: [`BP systolic ${systolic} mmHg`] };
    },
  },
  {
    id: 'circ.hypertensive_emergency',
    level: 'RED',
    title: 'Severe hypertension with symptoms',
    rationale: 'Very high blood pressure together with headache, visual change or chest pain may indicate a hypertensive emergency.',
    source: `Systolic ≥${BLOOD_PRESSURE.severeHypertensionSystolic} or diastolic ≥${BLOOD_PRESSURE.severeHypertensionDiastolic} mmHg with end-organ symptoms`,
    evaluate: (ctx) => {
      const { systolicBp, diastolicBp } = ctx.vitals;
      const severe =
        (systolicBp !== undefined && systolicBp >= BLOOD_PRESSURE.severeHypertensionSystolic) ||
        (diastolicBp !== undefined && diastolicBp >= BLOOD_PRESSURE.severeHypertensionDiastolic);
      if (!severe) return null;
      const symptoms = (['headache', 'blurred_vision', 'chest_pain', 'breathlessness'] as const).filter((code) => ctx.has(code));
      if (symptoms.length === 0) return null;
      return {
        detail: `Blood pressure ${systolicBp ?? '?'}/${diastolicBp ?? '?'} mmHg with ${symptoms.join(', ')}.`,
        codes: symptoms,
        measurements: [`BP ${systolicBp ?? '?'}/${diastolicBp ?? '?'} mmHg`],
      };
    },
  },
  {
    id: 'metabolic.severe_hypoglycaemia',
    level: 'BLACK',
    title: 'Severe hypoglycaemia',
    rationale: 'Blood glucose this low causes rapid neurological damage and needs sugar immediately, not a queue.',
    source: `Blood glucose below ${GLUCOSE_MG_DL.severeHypoglycaemia} mg/dL`,
    evaluate: (ctx) => {
      const glucose = ctx.vitals.bloodGlucoseMgDl;
      if (glucose === undefined || glucose >= GLUCOSE_MG_DL.severeHypoglycaemia) return null;
      return { detail: `Blood glucose ${glucose} mg/dL.`, measurements: [`Glucose ${glucose} mg/dL`] };
    },
  },
  {
    id: 'metabolic.hypoglycaemia',
    level: 'RED',
    title: 'Hypoglycaemia',
    rationale: 'Blood glucose below 54 mg/dL is clinically significant and needs treatment and a cause.',
    source: `Blood glucose below ${GLUCOSE_MG_DL.hypoglycaemia} mg/dL`,
    evaluate: (ctx) => {
      const glucose = ctx.vitals.bloodGlucoseMgDl;
      if (glucose === undefined) return null;
      if (glucose >= GLUCOSE_MG_DL.hypoglycaemia || glucose < GLUCOSE_MG_DL.severeHypoglycaemia) return null;
      return { detail: `Blood glucose ${glucose} mg/dL.`, measurements: [`Glucose ${glucose} mg/dL`] };
    },
  },
  {
    id: 'metabolic.hyperglycaemic_crisis',
    level: 'RED',
    title: 'Very high blood glucose',
    rationale: 'Glucose above 400 mg/dL, especially with vomiting or breathlessness, may indicate a hyperglycaemic crisis.',
    source: `Blood glucose above ${GLUCOSE_MG_DL.crisisHyperglycaemia} mg/dL`,
    evaluate: (ctx) => {
      const glucose = ctx.vitals.bloodGlucoseMgDl;
      if (glucose === undefined || glucose <= GLUCOSE_MG_DL.crisisHyperglycaemia) return null;
      return { detail: `Blood glucose ${glucose} mg/dL.`, measurements: [`Glucose ${glucose} mg/dL`] };
    },
  },
  {
    id: 'circ.adult_tachycardia',
    level: 'YELLOW',
    title: 'Abnormal heart rate in an adult',
    rationale: 'A resting rate outside 45–120 in an adult should be looked at the same day rather than queued routinely.',
    source: `Adult heart rate above ${HEART_RATE.adultTachycardia} or below ${HEART_RATE.adultBradycardia} bpm`,
    evaluate: (ctx) => {
      const hr = ctx.vitals.heartRate;
      const years = ctx.ageYears;
      if (hr === undefined || years === undefined || years < 18) return null;
      if (hr <= HEART_RATE.adultTachycardia && hr >= HEART_RATE.adultBradycardia) return null;
      return { detail: `Heart rate ${hr} bpm.`, measurements: [`Heart rate ${hr} bpm`] };
    },
  },

  // ---------------------------------------------------------------------------
  // Neonatal and paediatric
  // ---------------------------------------------------------------------------
  {
    id: 'paeds.young_infant_fever',
    level: 'RED',
    title: 'Fever in an infant under 2 months',
    rationale: 'Any fever in a young infant is treated as possible serious bacterial infection. Age matters more than how well the baby looks.',
    source: 'WHO IMCI young infant (0–2 months) severe illness criteria',
    evaluate: (ctx) => {
      const ageMonths = ctx.ageMonths;
      if (ageMonths === undefined || ageMonths >= YOUNG_INFANT_MONTHS) return null;
      const temp = ctx.vitals.temperatureC;
      if (temp !== undefined && temp >= TEMPERATURE_C.youngInfantFever) {
        return { detail: `Temperature ${temp}°C at ${ageMonths} months of age.`, measurements: [`Temperature ${temp}°C`] };
      }
      if (ctx.has('fever')) {
        return { detail: `Fever reported in an infant aged ${ageMonths} months.`, codes: ['fever'] };
      }
      return null;
    },
  },
  {
    id: 'paeds.young_infant_hypothermia',
    level: 'RED',
    title: 'Low temperature in an infant under 2 months',
    rationale: 'Hypothermia in a young infant is as strong a sign of severe illness as fever, and is easier to miss.',
    source: 'WHO IMCI young infant severe illness criteria',
    evaluate: (ctx) => {
      const ageMonths = ctx.ageMonths;
      const temp = ctx.vitals.temperatureC;
      if (ageMonths === undefined || ageMonths >= YOUNG_INFANT_MONTHS) return null;
      if (temp === undefined || temp > TEMPERATURE_C.youngInfantHypothermia) return null;
      return { detail: `Temperature ${temp}°C at ${ageMonths} months of age.`, measurements: [`Temperature ${temp}°C`] };
    },
  },
  {
    id: 'paeds.not_feeding',
    level: 'RED',
    title: 'Infant not feeding',
    rationale: 'Inability to feed is a general danger sign in a young child and a leading indicator of severe illness.',
    source: 'WHO IMCI general danger signs',
    evaluate: (ctx) => {
      const ageMonths = ctx.ageMonths;
      if (ageMonths === undefined || ageMonths >= UNDER_FIVE_MONTHS) return null;
      if (!ctx.has('not_feeding')) return null;
      return { detail: `Not feeding, at ${ageMonths} months of age.`, codes: ['not_feeding'] };
    },
  },
  {
    id: 'paeds.severe_dehydration',
    level: 'RED',
    title: 'Possible severe dehydration in a child',
    rationale: 'Diarrhoea with sunken eyes or inability to drink indicates severe dehydration, which kills children quickly.',
    source: 'WHO IMCI severe dehydration classification',
    evaluate: (ctx) => {
      const ageMonths = ctx.ageMonths;
      if (ageMonths === undefined || ageMonths >= UNDER_FIVE_MONTHS) return null;
      if (!ctx.has('diarrhoea') && !ctx.has('vomiting')) return null;
      const signs = (['unable_to_drink', 'sunken_eyes', 'reduced_urine'] as const).filter((code) => ctx.has(code));
      if (signs.length === 0) return null;
      return { detail: `Fluid loss with ${signs.join(', ')} at ${ageMonths} months of age.`, codes: signs };
    },
  },
  {
    id: 'general.hyperpyrexia',
    level: 'YELLOW',
    title: 'Very high temperature',
    rationale: 'A temperature at or above 40°C needs same-day assessment whatever the suspected cause.',
    source: `Temperature at or above ${TEMPERATURE_C.hyperpyrexia}°C`,
    evaluate: (ctx) => {
      const temp = ctx.vitals.temperatureC;
      if (temp === undefined || temp < TEMPERATURE_C.hyperpyrexia) return null;
      return { detail: `Temperature ${temp}°C.`, measurements: [`Temperature ${temp}°C`] };
    },
  },

  // ---------------------------------------------------------------------------
  // Obstetric
  // ---------------------------------------------------------------------------
  {
    id: 'obs.bleeding_in_pregnancy',
    level: 'RED',
    title: 'Bleeding in pregnancy',
    rationale: 'Vaginal bleeding during pregnancy is an obstetric emergency until assessed.',
    source: 'WHO danger signs in pregnancy',
    evaluate: (ctx) => {
      if (!ctx.pregnant) return null;
      if (!ctx.has('vaginal_bleeding') && !ctx.has('severe_bleeding')) return null;
      return { detail: 'Bleeding reported during pregnancy.', codes: ['vaginal_bleeding'] };
    },
  },
  {
    id: 'obs.eclampsia_risk',
    level: 'RED',
    title: 'Possible pre-eclampsia or eclampsia',
    rationale: 'A convulsion in pregnancy, or raised blood pressure with headache, visual change or swelling, may indicate eclampsia.',
    source: 'WHO danger signs in pregnancy; pre-eclampsia criteria',
    evaluate: (ctx) => {
      if (!ctx.pregnant) return null;
      if (ctx.has('convulsion')) {
        return { detail: 'Convulsion during pregnancy.', codes: ['convulsion'] };
      }
      const { systolicBp, diastolicBp } = ctx.vitals;
      const raised =
        (systolicBp !== undefined && systolicBp >= BLOOD_PRESSURE.pregnancyHypertensionSystolic) ||
        (diastolicBp !== undefined && diastolicBp >= BLOOD_PRESSURE.pregnancyHypertensionDiastolic);
      if (!raised) return null;
      const symptoms = (['headache', 'blurred_vision', 'swelling_face_hands'] as const).filter((code) => ctx.has(code));
      if (symptoms.length === 0) return null;
      return {
        detail: `Blood pressure ${systolicBp ?? '?'}/${diastolicBp ?? '?'} mmHg in pregnancy with ${symptoms.join(', ')}.`,
        codes: symptoms,
        measurements: [`BP ${systolicBp ?? '?'}/${diastolicBp ?? '?'} mmHg`],
      };
    },
  },
  {
    id: 'obs.reduced_foetal_movement',
    level: 'RED',
    disposition: 'DOCTOR_SAME_DAY',
    title: 'Reduced foetal movement',
    rationale: 'A reported reduction in foetal movement needs assessment the same day.',
    source: 'WHO danger signs in pregnancy',
    evaluate: (ctx) =>
      ctx.pregnant && ctx.has('reduced_foetal_movement')
        ? { detail: 'Reduced foetal movement reported.', codes: ['reduced_foetal_movement'] }
        : null,
  },

  // ---------------------------------------------------------------------------
  // Trauma, toxicology, abdominal
  // ---------------------------------------------------------------------------
  {
    id: 'bleed.severe',
    level: 'RED',
    title: 'Severe bleeding',
    rationale: 'Uncontrolled bleeding needs pressure applied and immediate transport, not triage.',
    source: 'Standard haemorrhage red flags',
    evaluate: (ctx) =>
      ctx.has('severe_bleeding') ? { detail: 'Severe or uncontrolled bleeding reported.', codes: ['severe_bleeding'] } : null,
  },
  {
    id: 'tox.snake_bite',
    level: 'RED',
    title: 'Snake bite',
    rationale: 'Snake bite needs the nearest facility holding antivenom. Time and immobilisation matter more than identification of the snake.',
    source: 'WHO snakebite envenoming guidance; Bangladesh National Guideline for Snakebite Management',
    evaluate: (ctx) => (ctx.has('snake_bite') ? { detail: 'Snake bite reported.', codes: ['snake_bite'] } : null),
  },
  {
    id: 'tox.poisoning',
    level: 'RED',
    title: 'Poisoning or overdose',
    rationale: 'Ingestion of poison, pesticide or an overdose requires immediate facility care. Pesticide self-poisoning is a leading cause of death in rural South Asia.',
    source: 'WHO guidance on pesticide self-poisoning',
    evaluate: (ctx) => (ctx.has('poisoning') ? { detail: 'Poisoning or overdose reported.', codes: ['poisoning'] } : null),
  },
  {
    id: 'abdo.acute_abdomen',
    level: 'RED',
    title: 'Possible acute abdomen',
    rationale: 'Abdominal pain with rigidity or guarding may indicate a surgical abdomen.',
    source: 'Standard acute abdomen red flags',
    evaluate: (ctx) =>
      ctx.has('abdominal_pain') && ctx.has('abdominal_rigidity')
        ? { detail: 'Abdominal pain with rigidity.', codes: ['abdominal_pain', 'abdominal_rigidity'] }
        : null,
  },

  // ---------------------------------------------------------------------------
  // Mental health
  // ---------------------------------------------------------------------------
  {
    id: 'mh.suicidal_ideation',
    level: 'RED',
    disposition: 'EMERGENCY_REFERRAL_NOW',
    title: 'Suicidal ideation',
    rationale:
      'Expressed intent to end one\'s life requires a named human to make contact now. This case must never sit in an automated queue or receive a templated reply.',
    source: 'WHO mhGAP intervention guide, self-harm and suicide module',
    evaluate: (ctx) =>
      ctx.has('suicidal_ideation')
        ? { detail: 'Language indicating suicidal intent. Route to a person immediately; do not auto-reply.', codes: ['suicidal_ideation'] }
        : null,
  },
];

/** Rules indexed by id, for audit trails that store only the id. */
export const RULES_BY_ID: ReadonlyMap<string, RedFlagRule> = new Map(RED_FLAG_RULES.map((rule) => [rule.id, rule]));
