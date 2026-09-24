/**
 * Handling one inbound message, from any channel.
 *
 * WhatsApp webhooks and messages typed into the patient portal both arrive here and take the
 * identical path: de-duplicate, find the patient, find or open their case, record the words,
 * extract, evaluate, reply, record everything. That sameness is the point of the channel
 * boundary. Adding a channel is writing an adapter; it never means a second copy of the logic
 * that decides whether someone is in danger.
 */

import type { FastifyBaseLogger } from 'fastify';
import { ChannelError, textOf, type InboundMessage, type WhatsAppAdapter } from '@hc/channels';
import { isImmediate, maxDisposition, maxLevel } from '@hc/core';
import type { LlmProvider } from '@hc/llm';
import type { CaseStore } from '@hc/store';

import { decideReply } from '../reply/policy.ts';
import { buildPriorContext } from './context.ts';
import { runIntake, summariseOutcome } from './pipeline.ts';

/**
 * How long an unclosed case keeps absorbing new messages from the same patient.
 *
 * Three days. Long enough that answering a follow-up question the next morning joins the
 * same thread; short enough that a case nobody closed does not silently swallow an
 * unrelated illness weeks later.
 */
export const CASE_CONTINUITY_MS = 72 * 60 * 60 * 1000;

export interface InboundDeps {
  readonly store: CaseStore;
  readonly provider: LlmProvider | null;
  readonly whatsapp: WhatsAppAdapter | null;
  readonly log: FastifyBaseLogger;
}

export interface InboundResult {
  readonly caseId: string;
  readonly patientId: string;
  readonly duplicate: boolean;
}

export function createInboundHandler(deps: InboundDeps) {
  const { store, provider, whatsapp, log } = deps;

  /**
   * @param knownPatientId Set for portal messages, where the patient is already signed in and
   *   must not be re-resolved from a channel identity.
   */
  return async function handleInbound(message: InboundMessage, knownPatientId?: string): Promise<InboundResult> {
    if (!(await store.markProcessed(message.externalId))) {
      log.info({ externalId: message.externalId }, 'duplicate message ignored');
      return { caseId: '', patientId: knownPatientId ?? '', duplicate: true };
    }

    const patient =
      knownPatientId !== undefined
        ? await store.getPatient(knownPatientId)
        : await store.resolvePatient(message.channel, message.senderRef, message.senderName);
    if (patient === null) throw new Error(`patient ${knownPatientId ?? '?'} not found`);

    let current = await store.findActiveCase(patient.id, CASE_CONTINUITY_MS);
    if (current === null) {
      current = await store.openCase(patient.id);
      await store.append(current.id, [
        { type: 'case.opened', actor: { kind: 'system', component: 'intake' }, data: { channel: message.channel } },
      ]);
    } else if (current.status === 'awaiting_patient') {
      // The patient answered. Back into the queue for a person to read.
      current = await store.setStatus(current.id, 'open');
    }
    const caseId = current.id;

    // The store is the system of record and holds the patient's words. Logs do not.
    await store.append(caseId, [
      {
        type: 'message.received',
        actor: { kind: 'patient', patientId: patient.id },
        at: message.receivedAt,
        data: {
          externalId: message.externalId,
          channel: message.channel,
          parts: message.parts.map((part) => part.kind),
          text: textOf(message),
        },
      },
    ]);

    // Everything the case already knows, replayed from its event log, so the kernel judges
    // the whole picture rather than the latest message alone.
    const prior = buildPriorContext(await store.eventsFor(caseId));
    const outcome = await runIntake(message, provider, prior);

    // A case's level only ever rises through automated evaluation. The kernel guarantees a
    // single verdict never falls below its rules or the model's suggestion — but each message
    // gets its own verdict, so without this a case the model called RED on Monday would drop
    // to GREEN when the patient writes "thank you" on Tuesday. Automated processing may raise
    // urgency; lowering it is a clinical judgement, and only a person makes those.
    const caseLevel = maxLevel(current.level, outcome.verdict.level);
    const caseDisposition = maxDisposition(current.disposition, outcome.verdict.disposition);

    await store.append(caseId, [
      {
        type: 'extraction.completed',
        actor: { kind: 'system', component: 'intake-pipeline' },
        data: {
          symptoms: outcome.extraction.symptoms,
          rejected: outcome.extraction.rejected,
          missing: outcome.extraction.missing,
          ageMonths: outcome.extraction.ageMonths ?? null,
          pregnant: outcome.extraction.pregnant ?? null,
          durationHours: outcome.extraction.durationHours ?? null,
          failure: outcome.extractionFailure,
          latencyMs: outcome.latencyMs,
        },
      },
      {
        type: 'safety.evaluated',
        // The kernel version is part of the actor, so a case decided months ago can be
        // replayed against the exact rules that decided it.
        actor: { kind: 'system', component: `safety-kernel@${outcome.verdict.kernelVersion}` },
        data: {
          level: outcome.verdict.level,
          disposition: outcome.verdict.disposition,
          firedRules: outcome.verdict.firedRules.map((rule) => ({
            id: rule.id,
            title: rule.title,
            detail: rule.evidence.detail,
            rationale: rule.rationale,
          })),
          aiSuggestion: outcome.verdict.aiSuggestion ?? null,
          escalatedFromAi: outcome.verdict.escalatedFromAi,
          extractionGaps: outcome.verdict.extractionGaps,
          caseLevel,
          heldAbove: caseLevel !== outcome.verdict.level,
        },
      },
    ]);

    await store.applyVerdict(caseId, {
      level: caseLevel,
      disposition: caseDisposition,
      symptomCodes: outcome.snapshot.symptoms.map((symptom) => symptom.code),
      missing: outcome.extraction.missing,
      firedRuleIds: outcome.verdict.firedRules.map((rule) => rule.id),
      ageMonths: outcome.snapshot.patient.ageMonths,
    });

    log.info({ ...summariseOutcome(outcome), caseId, patientId: patient.id }, 'intake complete');
    if (isImmediate(outcome.verdict)) {
      log.warn({ caseId, level: outcome.verdict.level }, 'EMERGENCY disposition — this case needs a human now');
    }

    await sendAutomatedReply(caseId, message, decideReply(outcome.verdict));
    return { caseId, patientId: patient.id, duplicate: false };
  };

  async function sendAutomatedReply(
    caseId: string,
    message: InboundMessage,
    reply: ReturnType<typeof decideReply>,
  ): Promise<void> {
    const actor = { kind: 'system', component: 'reply-policy' } as const;

    if (!reply.send) {
      await store.append(caseId, [{ type: 'reply.suppressed', actor, data: { reason: reply.reason } }]);
      return;
    }

    // A portal message is answered in the portal: the reply is the recorded event itself.
    if (message.channel !== 'whatsapp') {
      await store.append(caseId, [{ type: 'reply.sent', actor, data: { reason: reply.reason, text: reply.text, channel: 'web' } }]);
      return;
    }

    if (whatsapp === null) {
      await store.append(caseId, [{ type: 'reply.suppressed', actor, data: { reason: reply.reason, failed: true } }]);
      return;
    }

    try {
      const sent = await whatsapp.sendText(message.senderRef, reply.text);
      await store.append(caseId, [
        { type: 'reply.sent', actor, data: { reason: reply.reason, text: reply.text, channel: 'whatsapp', externalId: sent.externalId } },
      ]);
    } catch (error) {
      // Outside the 24-hour window a free-form reply is refused. Ordinary — but an emergency
      // that could not be delivered must be loud, because nobody is coming to read the log.
      const outsideWindow = error instanceof ChannelError && error.isOutsideServiceWindow;
      await store.append(caseId, [
        { type: 'reply.suppressed', actor, data: { reason: reply.reason, failed: true, outsideWindow } },
      ]);
      const level = reply.reason === 'emergency' ? 'error' : 'warn';
      log[level]({ caseId, reason: reply.reason, outsideWindow, error: String(error) }, 'reply could not be delivered');
    }
  }
}
