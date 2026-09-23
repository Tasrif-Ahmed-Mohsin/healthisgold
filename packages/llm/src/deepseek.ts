/**
 * DeepSeek provider.
 *
 * DeepSeek exposes an OpenAI-compatible chat-completions endpoint, so this driver is a thin
 * fetch wrapper with no SDK dependency. Swapping to any other OpenAI-compatible vendor is a
 * change of base URL and model names.
 *
 * Model note: the `deepseek-chat` and `deepseek-reasoner` aliases were retired in July 2026.
 * Current models are `deepseek-v4-flash` and `deepseek-v4-pro`.
 */

import {
  LlmError,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type ModelTier,
} from './provider.js';

export interface DeepSeekConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fastModel?: string;
  readonly reasoningModel?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  fastModel: 'deepseek-v4-flash',
  reasoningModel: 'deepseek-v4-pro',
  timeoutMs: 60_000,
  maxRetries: 2,
} as const;

/** Statuses worth retrying: rate limits and transient server faults. */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Truncates a provider error body before it reaches a log.
 *
 * Provider errors sometimes echo the offending request, and our requests contain patient
 * words. Capping the body keeps a 500 debuggable without spilling a consultation into a log
 * aggregator that has no business holding health data.
 */
function safeErrorBody(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
}

export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #models: Record<ModelTier, string>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(config: DeepSeekConfig) {
    if (config.apiKey.trim() === '') {
      throw new LlmError('DeepSeek API key is empty. Set DEEPSEEK_API_KEY in .env.');
    }
    this.#apiKey = config.apiKey;
    this.#baseUrl = (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    this.#models = {
      fast: config.fastModel ?? DEFAULTS.fastModel,
      reasoning: config.reasoningModel ?? DEFAULTS.reasoningModel,
    };
    this.#timeoutMs = config.timeoutMs ?? DEFAULTS.timeoutMs;
    this.#maxRetries = config.maxRetries ?? DEFAULTS.maxRetries;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const model = this.#models[request.tier ?? 'fast'];
    const startedAt = Date.now();

    const body = {
      model,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      max_tokens: request.maxTokens ?? 2048,
      // Low by default: this system uses models for extraction and structuring, where
      // creativity is a defect rather than a feature.
      temperature: request.temperature ?? 0.1,
      ...(request.json === true ? { response_format: { type: 'json_object' } } : {}),
      stream: false,
    };

    let lastError: LlmError | undefined;

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      if (attempt > 0) await sleep(2 ** (attempt - 1) * 500);

      try {
        const payload = await this.#post(body, request.signal);
        const text = payload.choices?.[0]?.message?.content;
        if (text === undefined || text === '') {
          throw new LlmError('DeepSeek returned no content.', { retryable: true });
        }

        const usage = payload.usage;
        return {
          text,
          model: payload.model ?? model,
          latencyMs: Date.now() - startedAt,
          finishReason: payload.choices?.[0]?.finish_reason,
          ...(usage
            ? {
                usage: {
                  promptTokens: usage.prompt_tokens ?? 0,
                  completionTokens: usage.completion_tokens ?? 0,
                  cachedTokens: usage.prompt_cache_hit_tokens,
                },
              }
            : {}),
        };
      } catch (error) {
        const llmError =
          error instanceof LlmError ? error : new LlmError(`DeepSeek request failed: ${String(error)}`, { cause: error });
        if (!llmError.retryable) throw llmError;
        lastError = llmError;
      }
    }

    throw lastError ?? new LlmError('DeepSeek request failed after retries.');
  }

  async #post(body: unknown, signal?: AbortSignal): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${this.#baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          // The key travels in a header, never in the URL — query strings end up in
          // proxy logs, browser history and error reports.
          Authorization: `Bearer ${this.#apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = safeErrorBody(await response.text().catch(() => ''));
        throw new LlmError(`DeepSeek returned ${response.status}: ${detail}`, {
          status: response.status,
          retryable: RETRYABLE_STATUSES.has(response.status),
        });
      }

      return (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError(`DeepSeek request timed out after ${this.#timeoutMs}ms.`, { retryable: true, cause: error });
      }
      // Network-level failures are worth retrying; an unreachable host is usually transient.
      throw new LlmError(`DeepSeek request failed: ${String(error)}`, { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
