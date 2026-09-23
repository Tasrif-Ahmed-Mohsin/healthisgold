/**
 * @hc/core — the clinical core.
 *
 * Framework-free and I/O-free by design. Nothing in this package imports a web framework,
 * a database driver or an HTTP client. Everything here can be reasoned about, tested and
 * reviewed by a clinician without running the rest of the system.
 */

export * from './domain/triage.js';
export * from './domain/snapshot.js';

export * from './safety/lexicon.js';
export * from './safety/context.js';
export * from './safety/rule.js';
export * from './safety/rules.js';
export * from './safety/thresholds.js';
export * from './safety/kernel.js';
