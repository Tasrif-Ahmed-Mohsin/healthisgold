/**
 * The shape of a red-flag rule.
 *
 * A rule is pure data plus a pure predicate. It cannot perform I/O, call a model, or read
 * anything outside the context it is handed. That constraint is the entire point: the
 * clinical safety behaviour of this system must be reproducible, diff-able in review, and
 * testable without a network.
 */

import type { Disposition, TriageLevel } from '../domain/triage.js';
import type { SymptomCode } from '../domain/snapshot.js';
import type { SafetyContext } from './context.js';

export interface RuleEvidence {
  /** Plain-language reason, written for the coordinator who will read it in the queue. */
  readonly detail: string;
  readonly codes?: readonly SymptomCode[];
  /** Human-readable vital readings that contributed, e.g. "SpO2 88%". */
  readonly measurements?: readonly string[];
}

export interface RedFlagRule {
  readonly id: string;
  readonly level: TriageLevel;
  /** Where this case should physically go. Defaults to the floor implied by `level`. */
  readonly disposition?: Disposition;
  readonly title: string;
  /** Why this is dangerous — shown to the reviewer, and to the CHW in the field. */
  readonly rationale: string;
  /** Clinical provenance. Every rule must name the guidance it came from. */
  readonly source: string;
  readonly evaluate: (ctx: SafetyContext) => RuleEvidence | null;
}

export interface FiredRule {
  readonly id: string;
  readonly level: TriageLevel;
  readonly disposition: Disposition;
  readonly title: string;
  readonly rationale: string;
  readonly source: string;
  readonly evidence: RuleEvidence;
}
