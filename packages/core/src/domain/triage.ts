/**
 * Triage levels and the ordering that lets the safety kernel escalate but never downgrade.
 *
 * The four-colour scheme matches what community health workers in Bangladesh are already
 * trained on through disaster-triage and IMCI materials, so the vocabulary is not new to them.
 */

export const TRIAGE_LEVELS = ['GREEN', 'YELLOW', 'RED', 'BLACK'] as const;

export type TriageLevel = (typeof TRIAGE_LEVELS)[number];

/**
 * Severity rank. Higher is more urgent. BLACK sits above RED because it means
 * "life-threatening right now" rather than "must be seen urgently".
 */
const RANK: Record<TriageLevel, number> = {
  GREEN: 0,
  YELLOW: 1,
  RED: 2,
  BLACK: 3,
};

export function rankOf(level: TriageLevel): number {
  return RANK[level];
}

export function isMoreUrgent(a: TriageLevel, b: TriageLevel): boolean {
  return RANK[a] > RANK[b];
}

/** Returns whichever level is more urgent. This is the only way the kernel combines levels. */
export function maxLevel(a: TriageLevel, b: TriageLevel): TriageLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

export function maxLevelOf(levels: readonly TriageLevel[], floor: TriageLevel = 'GREEN'): TriageLevel {
  return levels.reduce<TriageLevel>((acc, level) => maxLevel(acc, level), floor);
}

/**
 * What should physically happen next. Kept separate from the triage level because
 * two cases can share a colour but need different logistics — a RED chest pain goes
 * to a hospital, a RED suicidal-ideation case goes to a named human immediately.
 */
export const DISPOSITIONS = [
  'COORDINATOR_REVIEW',
  'DOCTOR_WITHIN_WEEK',
  'DOCTOR_SAME_DAY',
  'EMERGENCY_REFERRAL_NOW',
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

const DISPOSITION_RANK: Record<Disposition, number> = {
  COORDINATOR_REVIEW: 0,
  DOCTOR_WITHIN_WEEK: 1,
  DOCTOR_SAME_DAY: 2,
  EMERGENCY_REFERRAL_NOW: 3,
};

export function maxDisposition(a: Disposition, b: Disposition): Disposition {
  return DISPOSITION_RANK[a] >= DISPOSITION_RANK[b] ? a : b;
}

/** The floor disposition implied by a triage level when no rule specified something stronger. */
export function dispositionForLevel(level: TriageLevel): Disposition {
  switch (level) {
    case 'BLACK':
    case 'RED':
      return 'EMERGENCY_REFERRAL_NOW';
    case 'YELLOW':
      return 'DOCTOR_SAME_DAY';
    case 'GREEN':
      return 'COORDINATOR_REVIEW';
  }
}
