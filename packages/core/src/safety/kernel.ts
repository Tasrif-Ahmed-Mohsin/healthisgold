/**
 * The safety kernel.
 *
 * This is the one component in the system that is allowed to decide how urgent a case is,
 * and it contains no model call. A language model may *suggest* a level; the kernel takes
 * whichever of the two is more urgent and records that it did so.
 *
 * Three invariants hold for every verdict, and are asserted rather than assumed:
 *
 *   1. The verdict is never less urgent than the most urgent rule that fired.
 *   2. The verdict is never less urgent than the model's suggestion.
 *   3. `requiresHumanReview` is the literal `true` — it is not possible to construct a
 *      verdict that dispenses with a human, because the type has no other inhabitant.
 *
 * Together these mean a model can add urgency to a case but can never remove it, and no
 * output of this system reaches a patient without a person having seen it.
 */

import type { SymptomCode } from '../domain/snapshot.js';
import type { ClinicalSnapshot } from '../domain/snapshot.js';
import type { Disposition, TriageLevel } from '../domain/triage.js';
import { dispositionForLevel, isMoreUrgent, maxDisposition, maxLevel } from '../domain/triage.js';
import { buildSafetyContext, extractionGaps, type SafetyContext } from './context.js';
import type { FiredRule, RedFlagRule } from './rule.js';
import { RED_FLAG_RULES } from './rules.js';

/**
 * Bumped whenever the rule set or a threshold changes. Stored on every verdict so a case
 * decided months ago can be replayed against the exact logic that decided it.
 */
export const KERNEL_VERSION = '2026.09.1';

export interface SafetyVerdict {
  readonly level: TriageLevel;
  readonly disposition: Disposition;
  readonly firedRules: readonly FiredRule[];
  /** What the model proposed, if a model was consulted at all. */
  readonly aiSuggestion: TriageLevel | undefined;
  /** True when deterministic rules produced a more urgent level than the model did. */
  readonly escalatedFromAi: boolean;
  /** Danger signs present in the patient's words that the extraction layer failed to code. */
  readonly extractionGaps: readonly SymptomCode[];
  /** Structurally always true. See the module note. */
  readonly requiresHumanReview: true;
  readonly kernelVersion: string;
  readonly evaluatedAt: string;
}

export interface EvaluateOptions {
  /** A level proposed by a model. Purely advisory; it can raise the verdict, never lower it. */
  readonly aiSuggestion?: TriageLevel;
  /** Override the rule set. Intended for tests and for partner-specific rule packs. */
  readonly rules?: readonly RedFlagRule[];
  readonly now?: Date;
}

/** Runs the rule set and returns every rule that matched, in declaration order. */
export function applyRules(ctx: SafetyContext, rules: readonly RedFlagRule[] = RED_FLAG_RULES): FiredRule[] {
  const fired: FiredRule[] = [];
  for (const rule of rules) {
    const evidence = rule.evaluate(ctx);
    if (evidence === null) continue;
    fired.push({
      id: rule.id,
      level: rule.level,
      disposition: rule.disposition ?? dispositionForLevel(rule.level),
      title: rule.title,
      rationale: rule.rationale,
      source: rule.source,
      evidence,
    });
  }
  return fired;
}

export function evaluateSafety(snapshot: ClinicalSnapshot, options: EvaluateOptions = {}): SafetyVerdict {
  const { aiSuggestion, rules = RED_FLAG_RULES, now = new Date() } = options;

  const ctx = buildSafetyContext(snapshot);
  const firedRules = applyRules(ctx, rules);

  // The deterministic floor: the most urgent thing the rules found.
  const ruleFloor = firedRules.reduce<TriageLevel>((acc, rule) => maxLevel(acc, rule.level), 'GREEN');

  // The model may only add to that floor.
  const level = aiSuggestion === undefined ? ruleFloor : maxLevel(ruleFloor, aiSuggestion);

  const ruleDisposition = firedRules.reduce<Disposition>(
    (acc, rule) => maxDisposition(acc, rule.disposition),
    'COORDINATOR_REVIEW',
  );
  const disposition = maxDisposition(ruleDisposition, dispositionForLevel(level));

  const verdict: SafetyVerdict = {
    level,
    disposition,
    firedRules,
    aiSuggestion,
    escalatedFromAi: aiSuggestion !== undefined && isMoreUrgent(ruleFloor, aiSuggestion),
    extractionGaps: extractionGaps(ctx),
    requiresHumanReview: true,
    kernelVersion: KERNEL_VERSION,
    evaluatedAt: now.toISOString(),
  };

  assertKernelInvariants(verdict, ruleFloor);
  return verdict;
}

/**
 * Fails loudly rather than quietly shipping an unsafe verdict.
 *
 * If this ever throws in production it means a change to the combination logic has broken
 * the escalate-only guarantee, and refusing to produce a verdict is the correct response —
 * the case then surfaces to a human as an error instead of as a falsely reassuring GREEN.
 */
function assertKernelInvariants(verdict: SafetyVerdict, ruleFloor: TriageLevel): void {
  if (isMoreUrgent(ruleFloor, verdict.level)) {
    throw new Error(
      `Safety kernel invariant violated: verdict ${verdict.level} is less urgent than rule floor ${ruleFloor}.`,
    );
  }
  if (verdict.aiSuggestion !== undefined && isMoreUrgent(verdict.aiSuggestion, verdict.level)) {
    throw new Error(
      `Safety kernel invariant violated: verdict ${verdict.level} is less urgent than model suggestion ${verdict.aiSuggestion}.`,
    );
  }
}

/** True when the case must reach a person immediately rather than waiting in the queue. */
export function isImmediate(verdict: SafetyVerdict): boolean {
  return verdict.disposition === 'EMERGENCY_REFERRAL_NOW';
}

/**
 * Whether any automated reply may be sent to this patient at all.
 *
 * Cases carrying a suicidal-ideation flag are excluded from every automated path,
 * including acknowledgements — a templated message is the wrong thing to receive after
 * disclosing suicidal intent.
 */
export function allowsAutomatedReply(verdict: SafetyVerdict): boolean {
  return !verdict.firedRules.some((rule) => rule.id === 'mh.suicidal_ideation');
}
