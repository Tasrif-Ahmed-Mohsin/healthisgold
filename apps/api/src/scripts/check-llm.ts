/**
 * Configuration smoke test: proves the model provider works, in Bangla, end to end.
 *
 * Run it after putting a key in `.env` and any time extraction starts behaving oddly. It
 * deliberately uses a real Bangla complaint rather than "hello", because the failure that
 * matters is not "can we reach the API" — it is "can this model read how patients here
 * actually write". A provider that answers a smoke test in English and mangles Banglish is
 * a provider that fails in production only.
 *
 *   npm run check:llm -w @hc/api
 */

import { DeepSeekProvider, renderUntrusted, type LlmProvider } from '@hc/llm';
import { SYMPTOM_CODES, evaluateSafety, isSymptomCode, type SymptomObservation } from '@hc/core';

import { loadConfig } from '../config.ts';

/** Deliberately mixed: Bangla script, romanised Banglish, and a number written in Bangla digits. */
const SAMPLE = 'আমার ৩ দিন ধরে জ্বর আর matha betha. aj theke buke betha o hocche ar khub ghamchi.';

function buildPrompt(): { system: string; user: string } {
  const untrusted = renderUntrusted([{ label: 'patient message', content: SAMPLE }]);

  const system = [
    untrusted.guidance,
    '',
    'You extract structured symptoms from what a patient wrote. You do NOT diagnose, suggest a',
    'cause, or recommend treatment. Another system decides urgency; your only job is to report',
    'what the patient said, faithfully.',
    '',
    `Return JSON: {"symptoms": [{"code": "<code>", "evidence": "<the patient's own words>"}], "durationHours": <number|null>, "language": "<bn|en|mixed>"}`,
    '',
    `Use only these codes: ${SYMPTOM_CODES.join(', ')}.`,
    'Omit anything the patient did not actually say. Do not infer.',
  ].join('\n');

  return { system, user: untrusted.content };
}

interface Extraction {
  readonly symptoms: SymptomObservation[];
  /** Codes the model invented. Silently dropping these would hide a real quality signal. */
  readonly rejected: string[];
}

/**
 * Validates the model's output against the safety vocabulary.
 *
 * Model output is a proposal, and its *shape* is as untrustworthy as its content — a model
 * asked for JSON returns almost-JSON often enough that parsing without checking is how
 * invented symptom codes reach a clinical queue. Anything outside the vocabulary is rejected
 * and reported rather than passed along.
 */
function validateExtraction(payload: unknown): Extraction {
  const symptoms: SymptomObservation[] = [];
  const rejected: string[] = [];

  if (typeof payload !== 'object' || payload === null) return { symptoms, rejected };
  const raw = (payload as { symptoms?: unknown }).symptoms;
  if (!Array.isArray(raw)) return { symptoms, rejected };

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const code = (entry as { code?: unknown }).code;
    if (typeof code !== 'string') continue;
    if (!isSymptomCode(code)) {
      rejected.push(code);
      continue;
    }
    const evidence = (entry as { evidence?: unknown }).evidence;
    symptoms.push({ code, ...(typeof evidence === 'string' ? { evidence } : {}) });
  }

  return { symptoms, rejected };
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.llm === null) {
    console.error('No LLM configured. Put DEEPSEEK_API_KEY in .env (see .env.example), then retry.');
    process.exit(1);
  }

  console.log(`provider: ${config.llm.provider}`);
  console.log(`model:    ${config.llm.fastModel}`);
  console.log(`sample:   ${SAMPLE}\n`);

  const provider: LlmProvider = new DeepSeekProvider({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    fastModel: config.llm.fastModel,
    reasoningModel: config.llm.reasoningModel,
  });

  const { system, user } = buildPrompt();

  try {
    const result = await provider.complete({
      system,
      messages: [{ role: 'user', content: user }],
      tier: 'fast',
      json: true,
    });

    console.log(`ok — ${result.latencyMs}ms, model ${result.model}`);
    if (result.usage) {
      console.log(`tokens: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      // Worth seeing verbatim: a model that ignores the JSON instruction is a finding,
      // not a crash.
      console.log('\nmodel did not return JSON:\n');
      console.log(result.text);
      return;
    }

    const extracted = validateExtraction(parsed);
    console.log('\nextracted:');
    for (const symptom of extracted.symptoms) {
      console.log(`  ${symptom.code.padEnd(20)} "${symptom.evidence ?? ''}"`);
    }
    if (extracted.rejected.length > 0) {
      console.log(`  rejected (not in the safety vocabulary): ${extracted.rejected.join(', ')}`);
    }

    // The point of the whole exercise: what the model produced is an input to the kernel,
    // never a verdict. Run it through and show what the deterministic rules make of it.
    const verdict = evaluateSafety(
      {
        patient: { ageMonths: 45 * 12 },
        symptoms: extracted.symptoms,
        rawUtterances: [SAMPLE],
        vitals: {},
      },
      { aiSuggestion: 'GREEN' },
    );

    console.log(`\nkernel verdict: ${verdict.level} — ${verdict.disposition}`);
    console.log(`model suggested: ${verdict.aiSuggestion} (escalated: ${verdict.escalatedFromAi})`);
    for (const rule of verdict.firedRules) {
      console.log(`  [${rule.level}] ${rule.title} — ${rule.evidence.detail}`);
    }
    if (verdict.extractionGaps.length > 0) {
      console.log(`  extraction missed: ${verdict.extractionGaps.join(', ')}`);
    }
  } catch (error) {
    console.error(`\nfailed: ${String(error)}`);
    console.error('\nCheck the key in .env, and that the account has credit.');
    process.exit(1);
  }
}

void main();
