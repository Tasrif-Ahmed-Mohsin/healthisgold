/**
 * Bangladeshi mobile numbers, normalised to the form WhatsApp reports them in.
 *
 * WhatsApp gives us "8801720242416". A patient logging in on the web will type
 * "01720242416", "+880 1720-242416", or "1720242416", and all of those have to resolve to the
 * same patient or the login finds nobody. Operator prefixes are 013–019.
 */
export function normaliseBdPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (/^01[3-9]\d{8}$/.test(digits)) return `88${digits}`;
  if (/^8801[3-9]\d{8}$/.test(digits)) return digits;
  if (/^1[3-9]\d{8}$/.test(digits)) return `880${digits}`;
  return null;
}

/** "+880 1720-***416" — enough for a person to recognise their own number, not enough to harvest. */
export function maskPhone(normalised: string): string {
  if (normalised.length < 7) return '***';
  return `+${normalised.slice(0, 3)} ${normalised.slice(3, 7)}-***${normalised.slice(-3)}`;
}
