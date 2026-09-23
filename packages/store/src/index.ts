/**
 * @hc/store — the system of record.
 *
 * An append-only event log, with the case and patient tables as projections over it. That
 * shape gives the audit trail for free: "why was this case routed this way" is answered by
 * replaying its events, not by trusting a mutable row.
 */

export * from './model.js';
export * from './store.js';
export * from './sqlite.js';
