/**
 * SQLite implementation, on Node's built-in `node:sqlite`.
 *
 * Chosen for having no native build step and no dependency: a reviewer or a partner clinic
 * can clone this repository and have a working store with `npm install` alone. It is
 * genuinely adequate for a single-process pilot; it is not a multi-writer production
 * database, which is why everything goes through `CaseStore` rather than being called
 * directly.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Loaded through `createRequire` rather than a static import.
 *
 * `node:sqlite` is newer than Vite's list of Node builtins, so Vite's resolver strips the
 * `node:` prefix and then fails looking for a package named "sqlite" — which breaks the
 * test runner even though Node itself resolves it fine. A runtime require is opaque to
 * static analysis, so the import reaches Node untouched. The type import below is erased at
 * compile time and costs nothing.
 */
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

import type { Case, CaseStatus, DomainEvent, NewEvent, Patient, VerdictUpdate } from './model.js';
import type { CaseStore } from './store.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patients (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  display_name TEXT,
  age_months   INTEGER
);

CREATE TABLE IF NOT EXISTS patient_channels (
  channel    TEXT NOT NULL,
  ref        TEXT NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  PRIMARY KEY (channel, ref)
);

CREATE TABLE IF NOT EXISTS cases (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL REFERENCES patients(id),
  status         TEXT NOT NULL,
  level          TEXT NOT NULL,
  disposition    TEXT NOT NULL,
  opened_at      TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  symptom_codes  TEXT NOT NULL,
  missing        TEXT NOT NULL,
  fired_rule_ids TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cases_by_patient ON cases(patient_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS cases_by_status  ON cases(status, updated_at DESC);

-- Append-only. Nothing in this codebase updates or deletes a row here; the case and
-- patient tables are projections that can be rebuilt from it.
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  id      TEXT NOT NULL UNIQUE,
  case_id TEXT NOT NULL REFERENCES cases(id),
  type    TEXT NOT NULL,
  at      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  data    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_by_case ON events(case_id, seq);

CREATE TABLE IF NOT EXISTS processed_messages (
  external_id TEXT PRIMARY KEY,
  at          TEXT NOT NULL
);
`;

/** Severity order for the queue. Higher is more urgent. */
const LEVEL_RANK: Record<string, number> = { GREEN: 0, YELLOW: 1, RED: 2, BLACK: 3 };

interface CaseRow {
  id: string;
  patient_id: string;
  status: string;
  level: string;
  disposition: string;
  opened_at: string;
  updated_at: string;
  symptom_codes: string;
  missing: string;
  fired_rule_ids: string;
}

interface PatientRow {
  id: string;
  created_at: string;
  display_name: string | null;
  age_months: number | null;
}

function parseList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toCase(row: CaseRow): Case {
  return {
    id: row.id,
    patientId: row.patient_id,
    status: row.status as CaseStatus,
    level: row.level as Case['level'],
    disposition: row.disposition as Case['disposition'],
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    symptomCodes: parseList(row.symptom_codes),
    missing: parseList(row.missing),
    firedRuleIds: parseList(row.fired_rule_ids),
  };
}

function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    createdAt: row.created_at,
    displayName: row.display_name,
    ageMonths: row.age_months,
  };
}

export interface SqliteCaseStoreOptions {
  /** `:memory:` for tests, a file path otherwise. */
  readonly path: string;
  readonly now?: () => Date;
}

export class SqliteCaseStore implements CaseStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(options: SqliteCaseStoreOptions) {
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(SCHEMA);
    this.#now = options.now ?? (() => new Date());
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  async resolvePatient(channel: string, ref: string, displayName?: string | undefined): Promise<Patient> {
    const existing = this.#db
      .prepare(
        `SELECT p.* FROM patients p
         JOIN patient_channels c ON c.patient_id = p.id
         WHERE c.channel = ? AND c.ref = ?`,
      )
      .get(channel, ref) as PatientRow | undefined;

    if (existing !== undefined) {
      // Keep the display name fresh, but never overwrite a known name with nothing.
      if (displayName !== undefined && displayName !== existing.display_name) {
        this.#db.prepare('UPDATE patients SET display_name = ? WHERE id = ?').run(displayName, existing.id);
        return { ...toPatient(existing), displayName };
      }
      return toPatient(existing);
    }

    const id = randomUUID();
    const createdAt = this.#timestamp();
    this.#db
      .prepare('INSERT INTO patients (id, created_at, display_name, age_months) VALUES (?, ?, ?, NULL)')
      .run(id, createdAt, displayName ?? null);
    this.#db.prepare('INSERT INTO patient_channels (channel, ref, patient_id) VALUES (?, ?, ?)').run(channel, ref, id);

    return { id, createdAt, displayName: displayName ?? null, ageMonths: null };
  }

  async findActiveCase(patientId: string, withinMs: number): Promise<Case | null> {
    const cutoff = new Date(this.#now().getTime() - withinMs).toISOString();
    const row = this.#db
      .prepare(
        `SELECT * FROM cases
         WHERE patient_id = ? AND status != 'closed' AND updated_at >= ?
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(patientId, cutoff) as CaseRow | undefined;

    return row === undefined ? null : toCase(row);
  }

  async openCase(patientId: string): Promise<Case> {
    const id = randomUUID();
    const at = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO cases (id, patient_id, status, level, disposition, opened_at, updated_at, symptom_codes, missing, fired_rule_ids)
         VALUES (?, ?, 'open', 'GREEN', 'COORDINATOR_REVIEW', ?, ?, '[]', '[]', '[]')`,
      )
      .run(id, patientId, at, at);

    const opened = await this.getCase(id);
    if (opened === null) throw new Error(`failed to open case ${id}`);
    return opened;
  }

  async append(caseId: string, events: readonly NewEvent[]): Promise<void> {
    const insert = this.#db.prepare(
      'INSERT INTO events (id, case_id, type, at, actor, data) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const event of events) {
      insert.run(
        randomUUID(),
        caseId,
        event.type,
        event.at ?? this.#timestamp(),
        JSON.stringify(event.actor),
        JSON.stringify(event.data),
      );
    }
  }

  async applyVerdict(caseId: string, update: VerdictUpdate): Promise<Case> {
    this.#db
      .prepare(
        `UPDATE cases
         SET level = ?, disposition = ?, symptom_codes = ?, missing = ?, fired_rule_ids = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        update.level,
        update.disposition,
        JSON.stringify(update.symptomCodes),
        JSON.stringify(update.missing),
        JSON.stringify(update.firedRuleIds),
        this.#timestamp(),
        caseId,
      );

    if (update.ageMonths !== undefined) {
      // Only fill a blank. A value a human confirmed must not be overwritten by a later
      // model guess, and the model sees one message where a coordinator sees the patient.
      this.#db
        .prepare(
          `UPDATE patients SET age_months = ?
           WHERE age_months IS NULL AND id = (SELECT patient_id FROM cases WHERE id = ?)`,
        )
        .run(update.ageMonths, caseId);
    }

    const updated = await this.getCase(caseId);
    if (updated === null) throw new Error(`case ${caseId} disappeared during update`);
    return updated;
  }

  async setStatus(caseId: string, status: CaseStatus): Promise<Case> {
    this.#db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?').run(status, this.#timestamp(), caseId);
    const updated = await this.getCase(caseId);
    if (updated === null) throw new Error(`case ${caseId} not found`);
    return updated;
  }

  async markProcessed(externalId: string): Promise<boolean> {
    const existing = this.#db.prepare('SELECT external_id FROM processed_messages WHERE external_id = ?').get(externalId);
    if (existing !== undefined) return false;
    this.#db.prepare('INSERT INTO processed_messages (external_id, at) VALUES (?, ?)').run(externalId, this.#timestamp());
    return true;
  }

  async queue(limit = 50): Promise<Case[]> {
    const rows = this.#db
      .prepare(`SELECT * FROM cases WHERE status != 'closed' ORDER BY updated_at ASC LIMIT ?`)
      .all(limit * 4) as unknown as CaseRow[];

    // Ordering in SQL would need a CASE expression over level; doing it here keeps the
    // severity ranking in one place, next to the type that defines it.
    return rows
      .map(toCase)
      .sort((a, b) => {
        const severity = (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0);
        // Oldest first within a level: a queue that reorders by recency starves the
        // patient who has been waiting longest.
        return severity !== 0 ? severity : a.updatedAt.localeCompare(b.updatedAt);
      })
      .slice(0, limit);
  }

  async getCase(caseId: string): Promise<Case | null> {
    const row = this.#db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as CaseRow | undefined;
    return row === undefined ? null : toCase(row);
  }

  async getPatient(patientId: string): Promise<Patient | null> {
    const row = this.#db.prepare('SELECT * FROM patients WHERE id = ?').get(patientId) as PatientRow | undefined;
    return row === undefined ? null : toPatient(row);
  }

  async eventsFor(caseId: string): Promise<DomainEvent[]> {
    const rows = this.#db.prepare('SELECT * FROM events WHERE case_id = ? ORDER BY seq ASC').all(caseId) as {
      seq: number;
      id: string;
      case_id: string;
      type: string;
      at: string;
      actor: string;
      data: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      caseId: row.case_id,
      seq: row.seq,
      type: row.type as DomainEvent['type'],
      at: row.at,
      actor: JSON.parse(row.actor) as DomainEvent['actor'],
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
  }

  async casesForPatient(patientId: string, limit = 20): Promise<Case[]> {
    const rows = this.#db
      .prepare('SELECT * FROM cases WHERE patient_id = ? ORDER BY opened_at DESC LIMIT ?')
      .all(patientId, limit) as unknown as CaseRow[];
    return rows.map(toCase);
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
