/**
 * @hc/channels — transport adapters.
 *
 * This package deliberately does not depend on `@hc/core`. A channel must never be in a
 * position to influence a clinical decision, and the simplest way to guarantee that is for
 * it to have no way to reach the code that makes one.
 */

export * from './adapter.js';
export * from './simulated.js';
export * from './whatsapp/adapter.js';
export * from './whatsapp/inbound.js';
export * from './whatsapp/signature.js';
