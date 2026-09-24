import { afterEach, describe, expect, it } from 'vitest';

import { SqliteAuthStore, type AuthStore } from '../src/auth.js';

const stores: AuthStore[] = [];

function makeStore(now?: () => Date): AuthStore {
  const store = new SqliteAuthStore({ path: ':memory:', ...(now === undefined ? {} : { now }) });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe('staff accounts', () => {
  it('creates and finds a coordinator, case-insensitively by username', async () => {
    const store = makeStore();
    await store.createStaff({ username: 'Nusrat', displayName: 'Nusrat', role: 'coordinator', bmdcRegNo: null, passwordHash: 'h' });

    const found = await store.findStaffByUsername('nusrat');

    expect(found?.role).toBe('coordinator');
    expect(found?.passwordHash).toBe('h');
  });

  it('refuses a doctor account without a BMDC registration number', async () => {
    const store = makeStore();

    await expect(
      store.createStaff({ username: 'dr', displayName: 'Dr', role: 'doctor', bmdcRegNo: null, passwordHash: 'h' }),
    ).rejects.toThrow(/BMDC/);
  });

  it('never returns the password hash from the public lookups', async () => {
    const store = makeStore();
    const created = await store.createStaff({ username: 'a', displayName: 'A', role: 'admin', bmdcRegNo: null, passwordHash: 'secret-hash' });

    expect(JSON.stringify(await store.getStaff(created.id))).not.toContain('secret-hash');
    expect(JSON.stringify(await store.listStaff())).not.toContain('secret-hash');
  });
});

describe('sessions', () => {
  it('expires a session at its expiry time', async () => {
    let now = new Date('2026-09-24T10:00:00Z');
    const store = makeStore(() => now);
    await store.createSession('hash', { principalKind: 'staff', principalId: 's1', expiresAt: '2026-09-24T11:00:00Z' });

    expect(await store.getSession('hash')).not.toBeNull();
    now = new Date('2026-09-24T11:00:01Z');
    expect(await store.getSession('hash')).toBeNull();
  });

  it('signs someone out everywhere', async () => {
    const store = makeStore();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await store.createSession('a', { principalKind: 'staff', principalId: 's1', expiresAt });
    await store.createSession('b', { principalKind: 'staff', principalId: 's1', expiresAt });

    await store.deleteSessionsFor('staff', 's1');

    expect(await store.getSession('a')).toBeNull();
    expect(await store.getSession('b')).toBeNull();
  });
});

describe('login codes', () => {
  it('keeps one live code per phone and resets attempts on reissue', async () => {
    const store = makeStore();
    await store.saveOtp('8801720000000', 'first', '2099-01-01T00:00:00Z');
    await store.incrementOtpAttempts('8801720000000');
    await store.saveOtp('8801720000000', 'second', '2099-01-01T00:00:00Z');

    const otp = await store.getOtp('8801720000000');

    expect(otp?.codeHash).toBe('second');
    expect(otp?.attempts).toBe(0);
  });

  it('counts requests per number for rate limiting', async () => {
    const store = makeStore();
    for (let i = 0; i < 3; i += 1) await store.saveOtp('880172', `c${i}`, '2099-01-01T00:00:00Z');

    expect(await store.countOtpRequestsSince('880172', '2000-01-01T00:00:00Z')).toBe(3);
  });
});

describe('access log', () => {
  it('records who opened which case', async () => {
    const store = makeStore();
    await store.logAccess({ principalKind: 'staff', principalId: 's1', caseId: 'c1', action: 'case.viewed' });

    const log = await store.accessLogFor('c1');

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ principalId: 's1', action: 'case.viewed' });
  });
});
