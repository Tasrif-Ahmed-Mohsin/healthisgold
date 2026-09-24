/**
 * Accounts, sessions, login codes, and the record of who opened what.
 *
 * Nothing here handles a plaintext secret. Passwords arrive already hashed, session tokens
 * are stored as SHA-256 digests, and login codes likewise — so a copy of this database,
 * however it leaks, contains no credential anyone can replay. Hashing happens in the API,
 * which is the only layer that ever sees the plaintext.
 */

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import type { StaffRole } from './model.js';

// See sqlite.ts for why this is a runtime require rather than a static import.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = import('node:sqlite').DatabaseSync;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS staff_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL,
  bmdc_reg_no   TEXT,
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

-- token_hash, never the token. A leaked database must not contain a usable session.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash     TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_by_principal ON sessions(principal_kind, principal_id);

-- One live code per phone. Requesting a new one replaces the old.
CREATE TABLE IF NOT EXISTS patient_otps (
  phone      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- Every code request, kept so requests can be rate-limited per number.
CREATE TABLE IF NOT EXISTS otp_requests (
  phone TEXT NOT NULL,
  at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS otp_requests_by_phone ON otp_requests(phone, at);

-- Who opened which record. A clinical audit trail that records changes but not reads
-- cannot answer "who looked at this patient's file", which is the question a data
-- protection complaint begins with.
CREATE TABLE IF NOT EXISTS access_log (
  id             TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL,
  principal_id   TEXT NOT NULL,
  case_id        TEXT NOT NULL,
  action         TEXT NOT NULL,
  at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS access_log_by_case ON access_log(case_id, at);
`;

export interface StaffUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: StaffRole;
  /** Required for doctors. Stamped onto every clinical decision they sign. */
  readonly bmdcRegNo: string | null;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface StaffCredentials extends StaffUser {
  readonly passwordHash: string;
}

export type PrincipalKind = 'staff' | 'patient';

export interface SessionRecord {
  readonly principalKind: PrincipalKind;
  readonly principalId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface OtpRecord {
  readonly codeHash: string;
  readonly expiresAt: string;
  readonly attempts: number;
}

export interface AccessEntry {
  readonly principalKind: PrincipalKind;
  readonly principalId: string;
  readonly caseId: string;
  readonly action: string;
  readonly at: string;
}

export interface NewStaff {
  readonly username: string;
  readonly displayName: string;
  readonly role: StaffRole;
  readonly bmdcRegNo: string | null;
  readonly passwordHash: string;
}

export interface AuthStore {
  createStaff(input: NewStaff): Promise<StaffUser>;
  findStaffByUsername(username: string): Promise<StaffCredentials | null>;
  getStaff(id: string): Promise<StaffUser | null>;
  listStaff(): Promise<StaffUser[]>;
  setStaffPassword(id: string, passwordHash: string): Promise<void>;
  setStaffActive(id: string, active: boolean): Promise<void>;

  createSession(tokenHash: string, session: Omit<SessionRecord, 'createdAt'>): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  deleteSession(tokenHash: string): Promise<void>;
  /** Signs someone out everywhere — used when an account is deactivated. */
  deleteSessionsFor(kind: PrincipalKind, principalId: string): Promise<void>;

  saveOtp(phone: string, codeHash: string, expiresAt: string): Promise<void>;
  getOtp(phone: string): Promise<OtpRecord | null>;
  incrementOtpAttempts(phone: string): Promise<void>;
  deleteOtp(phone: string): Promise<void>;
  countOtpRequestsSince(phone: string, sinceIso: string): Promise<number>;

  logAccess(entry: Omit<AccessEntry, 'at'>): Promise<void>;
  accessLogFor(caseId: string): Promise<AccessEntry[]>;

  close(): Promise<void>;
}

interface StaffRow {
  id: string;
  username: string;
  display_name: string;
  role: string;
  bmdc_reg_no: string | null;
  password_hash: string;
  active: number;
  created_at: string;
}

function toStaff(row: StaffRow): StaffUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as StaffRole,
    bmdcRegNo: row.bmdc_reg_no,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

export interface SqliteAuthStoreOptions {
  readonly path: string;
  readonly now?: () => Date;
}

export class SqliteAuthStore implements AuthStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(options: SqliteAuthStoreOptions) {
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(SCHEMA);
    this.#now = options.now ?? (() => new Date());
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  async createStaff(input: NewStaff): Promise<StaffUser> {
    if (input.role === 'doctor' && (input.bmdcRegNo === null || input.bmdcRegNo.trim() === '')) {
      // Enforced in the store, not only the form: a doctor account without a registration
      // number would produce signed clinical decisions nobody can attribute to a licence.
      throw new Error('A doctor account requires a BMDC registration number.');
    }
    const id = randomUUID();
    const createdAt = this.#timestamp();
    this.#db
      .prepare(
        `INSERT INTO staff_users (id, username, display_name, role, bmdc_reg_no, password_hash, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(id, input.username.trim(), input.displayName.trim(), input.role, input.bmdcRegNo, input.passwordHash, createdAt);

    return {
      id,
      username: input.username.trim(),
      displayName: input.displayName.trim(),
      role: input.role,
      bmdcRegNo: input.bmdcRegNo,
      active: true,
      createdAt,
    };
  }

  async findStaffByUsername(username: string): Promise<StaffCredentials | null> {
    const row = this.#db.prepare('SELECT * FROM staff_users WHERE username = ?').get(username.trim()) as StaffRow | undefined;
    return row === undefined ? null : { ...toStaff(row), passwordHash: row.password_hash };
  }

  async getStaff(id: string): Promise<StaffUser | null> {
    const row = this.#db.prepare('SELECT * FROM staff_users WHERE id = ?').get(id) as StaffRow | undefined;
    return row === undefined ? null : toStaff(row);
  }

  async listStaff(): Promise<StaffUser[]> {
    const rows = this.#db.prepare('SELECT * FROM staff_users ORDER BY role, display_name').all() as unknown as StaffRow[];
    return rows.map(toStaff);
  }

  async setStaffPassword(id: string, passwordHash: string): Promise<void> {
    this.#db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
  }

  async setStaffActive(id: string, active: boolean): Promise<void> {
    this.#db.prepare('UPDATE staff_users SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }

  async createSession(tokenHash: string, session: Omit<SessionRecord, 'createdAt'>): Promise<void> {
    this.#db
      .prepare('INSERT INTO sessions (token_hash, principal_kind, principal_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, session.principalKind, session.principalId, this.#timestamp(), session.expiresAt);
  }

  async getSession(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as
      | { principal_kind: string; principal_id: string; created_at: string; expires_at: string }
      | undefined;
    if (row === undefined) return null;
    if (row.expires_at <= this.#timestamp()) {
      this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return {
      principalKind: row.principal_kind as PrincipalKind,
      principalId: row.principal_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  async deleteSessionsFor(kind: PrincipalKind, principalId: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE principal_kind = ? AND principal_id = ?').run(kind, principalId);
  }

  async saveOtp(phone: string, codeHash: string, expiresAt: string): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO patient_otps (phone, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
         ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(phone, codeHash, expiresAt);
    this.#db.prepare('INSERT INTO otp_requests (phone, at) VALUES (?, ?)').run(phone, this.#timestamp());
  }

  async getOtp(phone: string): Promise<OtpRecord | null> {
    const row = this.#db.prepare('SELECT * FROM patient_otps WHERE phone = ?').get(phone) as
      | { code_hash: string; expires_at: string; attempts: number }
      | undefined;
    return row === undefined ? null : { codeHash: row.code_hash, expiresAt: row.expires_at, attempts: row.attempts };
  }

  async incrementOtpAttempts(phone: string): Promise<void> {
    this.#db.prepare('UPDATE patient_otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
  }

  async deleteOtp(phone: string): Promise<void> {
    this.#db.prepare('DELETE FROM patient_otps WHERE phone = ?').run(phone);
  }

  async countOtpRequestsSince(phone: string, sinceIso: string): Promise<number> {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM otp_requests WHERE phone = ? AND at >= ?').get(phone, sinceIso) as {
      n: number;
    };
    return row.n;
  }

  async logAccess(entry: Omit<AccessEntry, 'at'>): Promise<void> {
    this.#db
      .prepare('INSERT INTO access_log (id, principal_kind, principal_id, case_id, action, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), entry.principalKind, entry.principalId, entry.caseId, entry.action, this.#timestamp());
  }

  async accessLogFor(caseId: string): Promise<AccessEntry[]> {
    const rows = this.#db.prepare('SELECT * FROM access_log WHERE case_id = ? ORDER BY at ASC').all(caseId) as unknown as {
      principal_kind: string;
      principal_id: string;
      case_id: string;
      action: string;
      at: string;
    }[];
    return rows.map((row) => ({
      principalKind: row.principal_kind as PrincipalKind,
      principalId: row.principal_id,
      caseId: row.case_id,
      action: row.action,
      at: row.at,
    }));
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
