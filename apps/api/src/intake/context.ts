/**
 * Rebuilding a case's clinical picture from its event log.
 *
 * This is the projection that matters most, and it is derived rather than stored. The
 * alternative — keeping a mutable "current symptoms" column and trusting it — is how a case
 * silently loses a complaint from three messages ago. Replaying the log means the picture is
 * always exactly what the patient actually said, and a bug in this function is visible and
 * fixable rather than baked into rows that were written wrong months earlier.
 */

import { isSymptomCode, type SymptomObservation } from '@hc/core';
import type { DomainEvent } from '@hc/store';

import type { PriorContext } from './pipeline.ts';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function buildPriorContext(events: readonly DomainEvent[]): PriorContext {
  const symptoms: SymptomObservation[] = [];
  const seen = new Set<string>();
  const utterances: string[] = [];
  let ageMonths: number | undefined;
  let pregnant: boolean | undefined;

  for (const event of events) {
    if (event.type === 'message.received') {
      const text = event.data['text'];
      if (typeof text === 'string' && text.trim() !== '') utterances.push(text);
      continue;
    }

    if (event.type !== 'extraction.completed') continue;

    const raw = event.data['symptoms'];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const record = asRecord(entry);
        const code = record?.['code'];
        if (typeof code !== 'string' || !isSymptomCode(code) || seen.has(code)) continue;
        seen.add(code);
        const evidence = record?.['evidence'];
        symptoms.push({ code, ...(typeof evidence === 'string' ? { evidence } : {}) });
      }
    }

    // First value wins. A fact a patient stated once is not un-stated by a later message
    // that happens not to repeat it.
    const age = event.data['ageMonths'];
    if (ageMonths === undefined && typeof age === 'number' && Number.isFinite(age)) ageMonths = age;

    const isPregnant = event.data['pregnant'];
    if (pregnant === undefined && typeof isPregnant === 'boolean') pregnant = isPregnant;
  }

  return { symptoms, utterances, ageMonths, pregnant };
}
