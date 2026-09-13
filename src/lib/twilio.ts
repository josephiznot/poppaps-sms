/**
 * Twilio over the Workers runtime: send via the REST API with `fetch`, and
 * validate inbound webhook signatures with Web Crypto (no Twilio SDK).
 */
import type { Env } from '../types';

export interface TwilioSendResult {
  sid: string;
  status: string;
}

/** A definite provider response. `retryable` is intentionally limited to
 * rate limits and provider/server failures; ambiguous fetch failures are not
 * wrapped and the durable delivery layer records them as UNKNOWN. */
export class TwilioSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TwilioSendError';
  }
}

/** The request may have reached Twilio, so the outbox must not resend it. */
export class TwilioAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TwilioAmbiguousError';
  }
}

/** Send one SMS and return Twilio's initial acceptance state. */
export async function sendSmsDetailed(
  env: Env,
  to: string,
  body: string,
  fetcher: typeof fetch = fetch,
  deliveryId?: string,
): Promise<TwilioSendResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });
  if (env.PUBLIC_BASE_URL) {
    const callback = new URL(`${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/sms/status`);
    if (deliveryId) callback.searchParams.set('DeliveryId', deliveryId);
    form.set('StatusCallback', callback.toString());
  }
  const res = await fetcher(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) {
    const raw = await res.text();
    let code: string | null = null;
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { code?: string | number; message?: string };
      code = parsed.code == null ? null : String(parsed.code);
      detail = parsed.message ?? raw;
    } catch {
      // Keep Twilio's raw response as the diagnostic when it is not JSON.
    }
    if (res.status >= 500) throw new TwilioAmbiguousError(`Twilio send outcome is uncertain (${res.status}): ${detail}`);
    throw new TwilioSendError(
      `Twilio send failed (${res.status}): ${detail}`,
      res.status,
      code,
      res.status === 429,
    );
  }
  const data = (await res.json()) as { sid?: string; status?: string };
  if (!data.sid) throw new TwilioAmbiguousError('Twilio accepted the request without returning a message SID');
  return { sid: data.sid, status: data.status ?? 'accepted' };
}

/** Backward-compatible direct sender for legacy reward/admin paths. New
 * automated work must queue through lib/delivery.ts before transport. */
export async function sendSms(env: Env, to: string, body: string): Promise<string> {
  return (await sendSmsDetailed(env, to, body)).sid;
}

/** Fetch current provider state for an accepted message. */
export async function getSmsStatus(
  env: Env,
  sid: string,
  fetcher: typeof fetch = fetch,
): Promise<{ status: string; errorCode: string | null }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages/${encodeURIComponent(sid)}.json`;
  const res = await fetcher(url, {
    headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`) },
  });
  if (!res.ok) throw new Error(`Twilio status lookup failed (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { status?: string; error_code?: string | number | null };
  return { status: data.status ?? 'unknown', errorCode: data.error_code == null ? null : String(data.error_code) };
}

/**
 * Verify the X-Twilio-Signature header.
 * https://www.twilio.com/docs/usage/security#validating-requests
 * Signature = base64( HMAC-SHA1( authToken, url + sortedConcat(params) ) ).
 */
export async function isValidTwilioSignature(
  authToken: string,
  signature: string | null,
  url: string,
  params: Record<string, string>,
): Promise<boolean> {
  if (!signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

/** Build a TwiML <Response><Message> reply. */
export function twiml(message: string): Response {
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(xml, { headers: { 'Content-Type': 'text/xml' } });
}

/** Empty TwiML <Response/> — acknowledge without replying. */
export function twimlEmpty(): Response {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response/>', {
    headers: { 'Content-Type': 'text/xml' },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
