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
  rsvpConfirmedMessage,
} from '../lib/messages';
import * as db from '../lib/db';

export const sms = new Hono<{ Bindings: Env }>();

/**
 * Confirm a pending tournament-seat invite (ADR-0006). Returns the reply text,
 * or null if this sender has no invite on the latest season (caller falls back
 * to normal handling). Re-confirming is idempotent and re-sends the details.
 */
async function confirmSeat(env: Env, from: string, now: string): Promise<string | null> {
  const member = await db.getMember(env.DB, from);
  if (member?.status !== 'SUBSCRIBED') return null;
  const rsvp = await db.rsvpForLatestSeason(env.DB, from);
  if (!rsvp) return null;
  await db.confirmRsvp(env.DB, rsvp.id, now);
  const season = await db.latestSeason(env.DB);
  const game = season?.snapshot.gameId ? await db.getGame(env.DB, season.snapshot.gameId) : null;
  return rsvpConfirmedMessage(env, game);
}

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
  const firstWord = body.trim().toLowerCase().split(/\s+/)[0] ?? '';

  // Tournament-seat confirmation. A bare "YES" from a member with a pending
  // invite also confirms (people reply YES no matter what the message asks);
  // for everyone else YES keeps its carrier opt-in meaning.
  if (intent === 'CONFIRM' || (intent === 'OPT_IN' && firstWord === 'yes')) {
    const reply = await confirmSeat(c.env, from, now);
    if (reply) return twiml(reply);
  }

  const member = await db.getMember(c.env.DB, from);

  // If we asked this member for their name, their next (non-keyword) text is it.
  // CONFIRM with no pending invite falls back here too — "In..." could be the
  // start of a name reply, and it behaved as UNKNOWN before RSVPs existed.
  if (intent === 'UNKNOWN' || intent === 'CONFIRM') {
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
      // Only nudge JOIN at people who aren't currently subscribed.
      return twiml(unknownMessage(c.env, member?.status === 'SUBSCRIBED'));
  }
});
