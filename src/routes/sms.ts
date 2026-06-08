/** POST /sms — Twilio inbound webhook. Player channel only (ADR-0005). */
import { Hono } from 'hono';
import type { Env } from '../types';
import { isValidTwilioSignature, twiml } from '../lib/twilio';
import {
  parseIntent,
  askNameMessage,
  nameConfirmedMessage,
  alreadyMemberMessage,
  optOutMessage,
  helpMessage,
  unknownMessage,
} from '../lib/messages';
import * as db from '../lib/db';

export const sms = new Hono<{ Bindings: Env }>();

sms.post('/', async (c) => {
  const raw = await c.req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const from = params.From;
  const body = params.Body ?? '';
  if (!from) return c.text('Missing From', 400);

  if (c.env.VALIDATE_TWILIO_SIGNATURE !== 'false') {
    const sig = c.req.header('X-Twilio-Signature') ?? null;
    const ok = await isValidTwilioSignature(c.env.TWILIO_AUTH_TOKEN, sig, c.req.url, params);
    if (!ok) return c.text('Invalid signature', 403);
  }

  const now = new Date().toISOString();
  const intent = parseIntent(body);

  // If we asked this member for their name, their next (non-keyword) text is it.
  if (intent === 'UNKNOWN') {
    const member = await db.getMember(c.env.DB, from);
    if (member?.awaiting_name === 1 && member.status === 'SUBSCRIBED') {
      const name = body.trim().slice(0, 40);
      if (name) {
        await db.setMemberName(c.env.DB, from, name, now);
        return twiml(nameConfirmedMessage(c.env, name));
      }
    }
  }

  switch (intent) {
    case 'OPT_IN': {
      const res = await db.joinMember(c.env.DB, from, `sms:${body.trim().slice(0, 20)}`, now);
      return twiml(res.alreadySubscribed ? alreadyMemberMessage(c.env) : askNameMessage(c.env));
    }
    case 'OPT_OUT':
      await db.optOutMember(c.env.DB, from, now);
      return twiml(optOutMessage(c.env));
    case 'HELP':
      return twiml(helpMessage(c.env));
    default:
      return twiml(unknownMessage(c.env));
  }
});
