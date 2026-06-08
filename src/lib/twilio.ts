/**
 * Twilio over the Workers runtime: send via the REST API with `fetch`, and
 * validate inbound webhook signatures with Web Crypto (no Twilio SDK).
 */
import type { Env } from '../types';

/** Send one SMS. Returns the message SID. Throws on a non-2xx Twilio response. */
export async function sendSms(env: Env, to: string, body: string): Promise<string> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Twilio send failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { sid?: string };
  return data.sid ?? '';
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
