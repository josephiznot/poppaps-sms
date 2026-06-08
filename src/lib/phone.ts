/** Phone helpers. Twilio gives inbound numbers in E.164; admin input is normalized. */

/** Normalize a US/NANP number to E.164, or null if it doesn't look valid. */
export function toE164(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Pretty US format: +16156951691 -> (615) 695-1691. */
export function formatUs(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
