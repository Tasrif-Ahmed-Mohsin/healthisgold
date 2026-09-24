/**
 * Creates the three demo staff accounts: an admin, a coordinator, and a doctor.
 *
 * Passwords are random and written to `data/demo-accounts.txt`, which is gitignored along
 * with the rest of `data/`. They are not printed, because a terminal's scrollback is a
 * worse place to keep a credential than a file you can delete.
 *
 *   npm run seed -w @hc/api              create any that are missing
 *   npm run seed -w @hc/api -- --rotate  also reset the passwords of existing ones
 *
 * The doctor's registration number is "DEMO-0001", deliberately not shaped like a real BMDC
 * number. A demo account must never be mistaken for, or collide with, a real doctor's licence.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SqliteAuthStore, type StaffRole } from '@hc/store';

import { hashPassword } from '../auth/password.ts';
import { loadConfig } from '../config.ts';

const DEMO: readonly { username: string; displayName: string; role: StaffRole; bmdcRegNo: string | null }[] = [
  { username: 'admin', displayName: 'System admin', role: 'admin', bmdcRegNo: null },
  { username: 'coordinator', displayName: 'Nusrat Jahan (Coordinator)', role: 'coordinator', bmdcRegNo: null },
  { username: 'doctor', displayName: 'Dr. Arif Rahman', role: 'doctor', bmdcRegNo: 'DEMO-0001' },
];

function newPassword(): string {
  // 16 characters from a URL-safe alphabet: ~96 bits. Easy to paste, impossible to guess.
  return randomBytes(12).toString('base64url');
}

async function main(): Promise<void> {
  const rotate = process.argv.includes('--rotate');
  const config = loadConfig();
  mkdirSync(dirname(config.storePath), { recursive: true });
  const auth = new SqliteAuthStore({ path: config.storePath });

  const lines = [
    'Demo staff accounts — local development only.',
    'Delete this file once you have noted the passwords. Never reuse these beyond a demo.',
    '',
  ];

  for (const account of DEMO) {
    const existing = await auth.findStaffByUsername(account.username);
    if (existing !== null && !rotate) {
      lines.push(`${account.role.padEnd(12)} ${account.username.padEnd(12)} (exists — run with --rotate to reset its password)`);
      continue;
    }

    const password = newPassword();
    const hash = await hashPassword(password);
    if (existing === null) {
      await auth.createStaff({ ...account, passwordHash: hash });
    } else {
      await auth.setStaffPassword(existing.id, hash);
      await auth.deleteSessionsFor('staff', existing.id);
    }
    lines.push(`${account.role.padEnd(12)} ${account.username.padEnd(12)} ${password}`);
  }

  const file = join(dirname(config.storePath), 'demo-accounts.txt');
  writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  await auth.close();

  console.log(`Demo accounts ${rotate ? 'reset' : 'ready'}. Usernames and passwords are in: ${file}`);
}

void main();
