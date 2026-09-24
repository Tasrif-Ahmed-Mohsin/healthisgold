/**
 * The store interface.
 *
 * Deliberately async even though the SQLite implementation is synchronous. The Personal
 * Data Protection Act, 2026 restricts cross-border transfer of health data, and the answer
 * to "where must this run" may change once a legal opinion lands. An async interface means
 * swapping SQLite for Postgres in Dhaka is writing one adapter, not rewriting every caller.
 */

import type { Case, DomainEvent, NewEvent, Patient, VerdictUpdate } from './model.js';

export interface CaseStore {
  /**
   * Finds the patient behind a channel identity, creating one if this is a first contact.
   *
   * A phone number is not an identity — numbers are reassigned and shared within families.
   * This is a pragmatic mapping that gets a case to a coordinator; confirming who someone
   * actually is belongs to the identity and consent layer, which a human drives.
   */
  resolvePatient(channel: string, ref: string, displayName?: string | undefined): Promise<Patient>;

  /**
   * The patient's current case, if one is still live.
   *
   * `withinMs` bounds how long an unclosed case keeps absorbing new messages. Without it, a
   * case nobody closed would silently swallow an unrelated illness months later; with it too
   * short, a patient answering a follow-up question the next morning starts a second case
   * and loses the thread.
   */
  findActiveCase(patientId: string, withinMs: number): Promise<Case | null>;

  openCase(patientId: string): Promise<Case>;

  append(caseId: string, events: readonly NewEvent[]): Promise<void>;

  /** Updates the case projection from a safety verdict. */
  applyVerdict(caseId: string, update: VerdictUpdate): Promise<Case>;

  setStatus(caseId: string, status: Case['status']): Promise<Case>;

  /**
   * Records a provider message id, returning false if it was already seen.
   *
   * Durable de-duplication. The in-memory version forgets everything on restart, and a
   * restart is exactly when Meta is most likely to retry a delivery it never got a 200 for.
   */
  markProcessed(externalId: string): Promise<boolean>;

  /** The queue: most urgent first, then oldest first within a level. Defaults to every non-closed status. */
  queue(limit?: number, statuses?: readonly Case['status'][]): Promise<Case[]>;

  /** Looks a patient up without creating one — for login, where an unknown number must stay unknown. */
  findPatientByChannelRef(channel: string, ref: string): Promise<Patient | null>;

  /** Every way this patient can be reached, so a reply goes back through the channel they use. */
  channelsForPatient(patientId: string): Promise<{ channel: string; ref: string }[]>;

  assignDoctor(caseId: string, doctorId: string | null): Promise<Case>;

  getCase(caseId: string): Promise<Case | null>;
  getPatient(patientId: string): Promise<Patient | null>;
  eventsFor(caseId: string): Promise<DomainEvent[]>;

  /** Previous cases for this patient — the history that means nobody starts from zero. */
  casesForPatient(patientId: string, limit?: number): Promise<Case[]>;

  close(): Promise<void>;
}
