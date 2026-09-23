/**
 * @hc/llm — provider-agnostic model access.
 *
 * Two rules hold for everything in this package:
 *
 *   1. Callers ask for a capability tier, never a vendor's model string.
 *   2. Anything that came from outside the system goes through `renderUntrusted` before it
 *      reaches a prompt.
 */

export * from './provider.js';
export * from './untrusted.js';
export * from './deepseek.js';
