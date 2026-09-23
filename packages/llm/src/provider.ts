/**
 * The provider interface.
 *
 * Callers ask for a capability tier, not a model name. That keeps the choice of vendor and
 * model out of the intake pipeline, so switching providers — or running a cheap model for
 * extraction and an expensive one for summarisation — is configuration rather than a code
 * change. It also means no clinical code ever hard-codes a vendor's string.
 */

/**
 * `fast` is for high-volume structured work: extraction, classification, normalisation.
 * `reasoning` is for the small number of calls that genuinely need it. The distinction is
 * a cost decision made once here rather than scattered across call sites.
 */
export type ModelTier = 'fast' | 'reasoning';

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  readonly role: LlmRole;
  readonly content: string;
}

export interface CompletionRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly tier?: ModelTier;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Ask the provider for a JSON object. Still validate the result — this is a hint, not a guarantee. */
  readonly json?: boolean;
  readonly signal?: AbortSignal;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Tokens served from the provider's prompt cache, where reported. */
  readonly cachedTokens?: number;
}

export interface CompletionResult {
  readonly text: string;
  readonly model: string;
  readonly usage?: TokenUsage;
  readonly finishReason?: string;
  readonly latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Thrown for every provider failure.
 *
 * It carries the status and a truncated body so a failure is debuggable, and deliberately
 * never carries the request — a request body contains patient words, and an error is the
 * single most likely thing to end up in a log aggregator.
 */
export class LlmError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}
