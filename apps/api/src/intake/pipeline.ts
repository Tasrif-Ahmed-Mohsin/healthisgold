/**
 * The intake pipeline.
 *
 * One inbound message in, one safety verdict out. The order matters and is the whole
 * argument of the system: a model reads the message, and then deterministic rules decide
 * how urgent it is. Never the other way round.
 *
 * Note what happens when extraction fails completely — a timeout, a malformed reply, an
 * outage. The pipeline does not abort. It runs the kernel anyway on the patient's raw words,
 * where the trilingual lexicon can still catch "বুকে ব্যথা". A model being down degrades the
 * quality of a case summary; it must never degrade the detection of an emergency.
 */

import { evaluateSafety, type ClinicalSnapshot, type SafetyVerdict, type SymptomObservation } from '@hc/core';
import { textOf, type InboundMessage, type MessagePart } from '@hc/channels';
import type { LlmProvider } from '@hc/llm';

import { buildExtractionPrompt, emptyExtraction, parseExtraction, type Extraction } from './extract.ts';

/**
 * What the case already knew before this message arrived.
 *
 * A case accumulates a clinical picture; a message does not replace it. Someone who reports
 * fever on Monday and vomiting on Tuesday has both, and a kernel shown only Tuesday would
 * evaluate a patient who never had a fever. Several rules — fever with neck stiffness,
 * diarrhoea with sunken eyes — only fire on combinations that arrive across messages.
 */
export interface PriorContext {
  readonly symptoms: readonly SymptomObservation[];
  readonly utterances: readonly string[];
  readonly ageMonths?: number | undefined;
  readonly pregnant?: boolean | undefined;
}

/** Union by code, keeping the earliest evidence span for each. */
function mergeSymptoms(
  prior: readonly SymptomObservation[],
  fresh: readonly SymptomObservation[],
): SymptomObservation[] {
  const byCode = new Map<string, SymptomObservation>();
  for (const symptom of [...prior, ...fresh]) {
    if (!byCode.has(symptom.code)) byCode.set(symptom.code, symptom);
  }
  return [...byCode.values()];
}

export interface IntakeOutcome {
  readonly externalId: string;
  readonly snapshot: ClinicalSnapshot;
  readonly verdict: SafetyVerdict;
  /** What this message alone produced. The snapshot holds the accumulated picture. */
  readonly extraction: Extraction;
  /** Media the patient sent that has not been processed yet — still needs a human to open it. */
  readonly pendingMedia: readonly MessagePart['kind'][];
  /** True when the model call failed and the kernel ran on raw text alone. */
  readonly extractionFailed: boolean;
  /** Why it failed, for the log. Null when extraction succeeded. */
  readonly extractionFailure: 'error' | 'truncated' | 'unparseable' | null;
  readonly latencyMs: number;
}

export async function runIntake(
  message: InboundMessage,
  provider: LlmProvider | null,
  prior: PriorContext = { symptoms: [], utterances: [] },
): Promise<IntakeOutcome> {
  const startedAt = Date.now();
  const text = textOf(message);

  const pendingMedia = message.parts
    .filter((part) => part.kind === 'audio' || part.kind === 'image' || part.kind === 'document')
    .map((part) => part.kind);

  let extraction: Extraction = emptyExtraction();
  let extractionFailure: IntakeOutcome['extractionFailure'] = null;

  if (provider !== null && text !== '') {
    try {
      const { system, user } = buildExtractionPrompt(text);
      const result = await provider.complete({
        system,
        messages: [{ role: 'user', content: user }],
        tier: 'fast',
        json: true,
        // Generous headroom. A reply cut off at the token ceiling is truncated mid-JSON
        // and parses as nothing, which is the worst possible failure shape here: it looks
        // exactly like a patient with no symptoms.
        maxTokens: 3000,
      });

      if (result.finishReason === 'length') {
        extractionFailure = 'truncated';
      } else {
        const parsed = parseExtraction(result.text);
        if (parsed === null) extractionFailure = 'unparseable';
        else extraction = parsed;
      }
    } catch {
      // Swallowed deliberately: see the module note. The kernel still runs below.
      extractionFailure = 'error';
    }
  }

  // Age and pregnancy already established stay established. A later message that simply
  // does not mention age must not erase it.
  const ageMonths = extraction.ageMonths ?? prior.ageMonths;
  const pregnant = extraction.pregnant ?? prior.pregnant;

  const snapshot: ClinicalSnapshot = {
    patient: {
      ...(ageMonths === undefined ? {} : { ageMonths }),
      ...(pregnant === undefined ? {} : { pregnant }),
    },
    symptoms: mergeSymptoms(prior.symptoms, extraction.symptoms),
    // Every message the patient has sent in this case, not just the latest. The lexicon
    // reads all of them, so a danger sign mentioned two messages ago still counts.
    rawUtterances: [...prior.utterances, ...(text === '' ? [] : [text])],
    vitals: {},
  };

  const verdict = evaluateSafety(snapshot, {
    ...(extraction.suggestedUrgency === undefined ? {} : { aiSuggestion: extraction.suggestedUrgency }),
  });

  return {
    externalId: message.externalId,
    snapshot,
    verdict,
    extraction,
    pendingMedia,
    extractionFailed: extractionFailure !== null,
    extractionFailure,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * A log-safe summary of an outcome.
 *
 * Symptom codes, rule ids and levels are clinical metadata and safe to record. The patient's
 * words — including the `evidence` spans the model quoted — are not, and never appear here.
 */
export function summariseOutcome(outcome: IntakeOutcome): Record<string, unknown> {
  return {
    externalId: outcome.externalId,
    level: outcome.verdict.level,
    disposition: outcome.verdict.disposition,
    firedRules: outcome.verdict.firedRules.map((rule) => rule.id),
    aiSuggested: outcome.verdict.aiSuggestion ?? null,
    escalatedFromAi: outcome.verdict.escalatedFromAi,
    symptoms: outcome.snapshot.symptoms.map((symptom) => symptom.code),
    newSymptoms: outcome.extraction.symptoms.map((symptom) => symptom.code),
    rejectedCodes: outcome.extraction.rejected,
    extractionGaps: outcome.verdict.extractionGaps,
    missing: outcome.extraction.missing,
    pendingMedia: outcome.pendingMedia,
    extractionFailed: outcome.extractionFailed,
    extractionFailure: outcome.extractionFailure,
    latencyMs: outcome.latencyMs,
  };
}
