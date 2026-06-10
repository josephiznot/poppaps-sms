/** Opaque public player ids — SHA-256(phone), truncated. Deterministic and
 *  non-reversible in practice, so public profile URLs never carry PII (ADR-0005). */

/** First 16 hex chars of SHA-256(phone). */
export async function playerId(phone: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(phone));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** id → phone lookup for a member list (resolve a /player/:id URL). */
export async function playerIdMap(phones: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const phone of phones) out.set(await playerId(phone), phone);
  return out;
}
