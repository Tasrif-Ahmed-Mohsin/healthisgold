/**
 * Password hashing with scrypt, from Node's standard library.
 *
 * scrypt is memory-hard, so guessing at scale needs memory as well as compute, which is what
 * makes a stolen hash expensive to crack. No dependency is involved: the parameters are
 * stored alongside each hash, so they can be raised later without invalidating existing
 * accounts.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LENGTH = 64;
const PARAMS = { N: 16_384, r: 8, p: 1 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
}

/** Format: scrypt$N$r$p$salt$hash, with salt and hash base64url-encoded. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, hashText] = parts;
  const expected = Buffer.from(hashText ?? '', 'base64url');
  if (expected.length === 0) return false;

  const derived = await scrypt(password, Buffer.from(saltText ?? '', 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A hash of a password nobody knows, verified against when the username does not exist.
 *
 * Without it, "no such user" returns in microseconds and "wrong password" takes tens of
 * milliseconds, and that difference tells an attacker which usernames are real.
 */
export const DECOY_HASH_PROMISE: Promise<string> = hashPassword(randomBytes(32).toString('hex'));

/** Minimum bar for a staff password. Length beats composition rules. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}
