/**
 * What the system is allowed to say to a patient without a human having seen it.
 *
 * Every reply here is a fixed string selected by the deterministic safety kernel. Nothing a
 * model wrote is ever sent. That is not caution for its own sake: a model asked to comfort
 * someone will eventually write "this does not sound serious", and an automated reassurance
 * that delays a person with chest pain is the most dangerous output this system could
 * produce. It cannot produce it, because no code path exists that would let it.
 *
 * Three cases:
 *
 *   - **Emergency (RED / BLACK).** A fixed instruction to seek care now. This is the one
 *     piece of clinical direction worth automating, because the harm being prevented is
 *     delay, and the advice only ever errs toward care. It names no condition.
 *   - **Everything else.** An acknowledgement. It confirms receipt and sets the expectation
 *     that a person will read it. It makes no claim about the patient's condition at all.
 *   - **Suicidal ideation.** Nothing. A templated auto-reply is the wrong thing to receive
 *     after disclosing intent to end your life; that case goes straight to a named human.
 */

import { allowsAutomatedReply, isImmediate, type SafetyVerdict } from '@hc/core';

export interface ReplyDecision {
  readonly send: boolean;
  readonly text: string;
  /** Why this was chosen — recorded on the case so a reviewer can see what the patient got. */
  readonly reason: 'emergency' | 'acknowledgement' | 'suppressed-mental-health';
}

/**
 * Sent when the kernel returns an emergency disposition.
 *
 * Written for someone frightened and possibly alone. Short sentences, the action first,
 * no medical vocabulary. "may need" rather than a claim about what is wrong, and an
 * explicit statement that a person is now involved, so it does not read as a dead end.
 */
const EMERGENCY_BN = [
  'আপনার বর্ণনা অনুযায়ী এখনই একজন ডাক্তার দেখানো প্রয়োজন হতে পারে।',
  'দয়া করে এখনই নিকটস্থ হাসপাতাল বা জরুরি বিভাগে যান। দেরি করবেন না।',
  'সম্ভব হলে কাউকে সঙ্গে নিয়ে যান।',
  '',
  'আমাদের একজন স্বাস্থ্যকর্মী আপনার বার্তাটি এখন দেখছেন।',
].join('\n');

const EMERGENCY_EN = [
  'Based on what you described, you may need to see a doctor right now.',
  'Please go to the nearest hospital or emergency department now. Do not wait.',
  'Take someone with you if you can.',
  '',
  'One of our health workers is reviewing your message now.',
].join('\n');

/**
 * Sent for everything else.
 *
 * Deliberately says nothing about the condition — not "it sounds mild", not "nothing to
 * worry about". It reports only what is true: the message arrived and a person will read it.
 */
const ACKNOWLEDGEMENT_BN = [
  'আপনার বার্তা পেয়েছি।',
  'একজন স্বাস্থ্যকর্মী এটি দেখে শীঘ্রই আপনার সাথে যোগাযোগ করবেন।',
  '',
  'অবস্থা খারাপ হলে বা নতুন কোনো সমস্যা হলে সঙ্গে সঙ্গে জানান, অথবা নিকটস্থ হাসপাতালে যান।',
].join('\n');

const ACKNOWLEDGEMENT_EN = [
  'We have received your message.',
  'A health worker will review it and contact you shortly.',
  '',
  'If you get worse or something new happens, tell us straight away, or go to your nearest hospital.',
].join('\n');

/**
 * The safety-netting line in the acknowledgement is not filler.
 *
 * A patient who has been told "a health worker will look at this" may wait on a reply while
 * getting worse. Naming the conditions under which they should stop waiting is what makes
 * an acknowledgement safe to send at all.
 */
export function decideReply(verdict: SafetyVerdict): ReplyDecision {
  if (!allowsAutomatedReply(verdict)) {
    return { send: false, text: '', reason: 'suppressed-mental-health' };
  }

  if (isImmediate(verdict)) {
    return { send: true, text: `${EMERGENCY_BN}\n\n---\n${EMERGENCY_EN}`, reason: 'emergency' };
  }

  return { send: true, text: `${ACKNOWLEDGEMENT_BN}\n\n---\n${ACKNOWLEDGEMENT_EN}`, reason: 'acknowledgement' };
}
