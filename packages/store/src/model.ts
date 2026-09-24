/**
 * The persisted model.
 *
 * One rule governs this package and it is the opposite of the logging rule elsewhere: **the
 * store holds patient content, and logs do not.** A coordinator has to read what the patient
 * actually wrote, so the message text lives here. The distinction that matters is not
 * whether content is stored but where: an access-controlled record is the right place for
 * it, a log aggregator is not.
 */

import type { Disposition, TriageLevel } from '@hc/core';

export type CaseStatus =
  /** Waiting for a coordinator to pick it up. */
  | 'open'
  /** A question has gone to the patient; we are waiting on them. */
  | 'awaiting_patient'
  /** Escalated to a registered doctor. */
  | 'with_doctor'
  | 'closed';

export interface Patient {
  readonly id: string;
  readonly createdAt: string;
  /**
   * Whatever the messaging provider reports. The sender chooses this string, so it is
   * untrusted and for display only — never for identifying anyone.
   */
  readonly displayName: string | null;
  readonly ageMonths: number | null;
}

export interface Case {
  readonly id: string;
  readonly patientId: string;
  readonly status: CaseStatus;
  readonly level: TriageLevel;
  readonly disposition: Disposition;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly symptomCodes: readonly string[];
  /** What a coordinator still needs to ask. */
  readonly missing: readonly string[];
  /** Ids of the rules that produced the current level, for the audit trail. */
  readonly firedRuleIds: readonly string[];
  /** The registered doctor a coordinator routed this case to, if any. */
  readonly assignedDoctorId: string | null;
}

/**
 * Staff roles, and the line between them is legal rather than organisational.
 *
 * Only a BMDC-registered doctor may diagnose, prescribe, or sign a clinical decision. A
 * coordinator — nurse, SACMO, CHCP, intern — asks, measures, routes and follows up. An admin
 * manages accounts and deliberately cannot read cases at all: running the system does not
 * require seeing anyone's health record, so the role does not get to.
 */
export type StaffRole = 'coordinator' | 'doctor' | 'admin';

/**
 * Who caused an event.
 *
 * Recorded on every event because "who decided this" is the question a regulator, a
 * supervising physician, or an incident review will ask first. A system actor names its
 * component so an automated action is never mistaken for a human one.
 */
export type Actor =
  | { readonly kind: 'patient'; readonly patientId: string }
  | { readonly kind: 'system'; readonly component: string }
  | { readonly kind: 'staff'; readonly staffId: string; readonly role: StaffRole };

export type DomainEventType =
  | 'case.opened'
  | 'message.received'
  | 'extraction.completed'
  | 'safety.evaluated'
  | 'reply.sent'
  | 'reply.suppressed'
  /** Internal to staff. Never shown to the patient. */
  | 'note.added'
  /** A person asked the patient something. */
  | 'question.sent'
  /** A coordinator handed the case to a doctor. */
  | 'case.routed'
  /** A doctor's clinical decision, stamped with their registration number. */
  | 'assessment.signed'
  | 'case.closed';

export interface NewEvent {
  readonly type: DomainEventType;
  readonly actor: Actor;
  readonly data: Readonly<Record<string, unknown>>;
  readonly at?: string;
}

export interface DomainEvent extends NewEvent {
  readonly id: string;
  readonly caseId: string;
  readonly at: string;
  /** Monotonic within the store. Gives a total order that timestamps alone cannot. */
  readonly seq: number;
}

export interface VerdictUpdate {
  readonly level: TriageLevel;
  readonly disposition: Disposition;
  readonly symptomCodes: readonly string[];
  readonly missing: readonly string[];
  readonly firedRuleIds: readonly string[];
  readonly ageMonths?: number | undefined;
}
