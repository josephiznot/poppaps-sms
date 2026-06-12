/** Cron + side-effect logic: send reminders, evaluate attendance rewards. */
import type { Env } from '../types';
import * as db from './db';
import { sendSms } from './twilio';
import { gameReminder, promoMessage } from './messages';
import { crossedRewardThreshold } from './points';
import { RECURRING, localDateInTz, addDaysToKey, seriesDatesBetween, zonedToUtcIso, gameLocalDates } from './schedule';

/** Split a phone list by membership in the subscribed set (pure; unit-tested). */
export function partitionBySubscribed(
  phones: string[],
  subscribed: Set<string>,
): { subscribed: string[]; optedOut: string[] } {
  const ok: string[] = [];
  const out: string[] = [];
  for (const phone of phones) (subscribed.has(phone) ? ok : out).push(phone);
  return { subscribed: ok, optedOut: out };
}

/**
 * Send a message to many phones sequentially (10DLC is ~1 msg/sec).
 * STOP compliance is enforced HERE: the list is intersected with currently
 * subscribed members before anything is sent, so an opted-out number can never
 * be texted even if a caller forgets to pre-filter. Callers may still
 * pre-filter (for accurate counts/UI), but this helper enforces regardless.
 */
export async function broadcast(env: Env, phones: string[], message: string): Promise<{ sent: number; failed: number }> {
  const subscribedSet = new Set(await db.listSubscribedPhones(env.DB));
  const { subscribed: sendable, optedOut: skipped } = partitionBySubscribed(phones, subscribedSet);
  if (skipped.length > 0) {
    // Log last-4 only — never full numbers.
    console.log(
      JSON.stringify({ msg: 'broadcast skipped unsubscribed', skipped: skipped.length, last4: skipped.map((p) => p.slice(-4)) }),
    );
  }
  let sent = 0;
  let failed = 0;
  for (const phone of sendable) {
    try {
      await sendSms(env, phone, message);
      sent++;
    } catch (err) {
      failed++;
      console.error(JSON.stringify({ msg: 'sms failed', phone, error: String(err) }));
    }
  }
  return { sent, failed };
}

/**
 * Cron job: keep the recurring biweekly game materialized so reminders fire.
 * Creates any series occurrence within the horizon that doesn't already exist;
 * a cancelled/skipped occurrence keeps its row, so it's never regenerated.
 */
export async function ensureUpcomingGames(env: Env, now = new Date()): Promise<number> {
  const tz = env.TIMEZONE;
  const fromKey = localDateInTz(now, tz);
  const toKey = addDaysToKey(fromKey, RECURRING.horizonDays);
  const dates = seriesDatesBetween(RECURRING.anchorDate, RECURRING.intervalDays, fromKey, toKey);
  const occupied = gameLocalDates(await db.listGames(env.DB), tz); // non-cancelled days already taken

  let created = 0;
  for (const date of dates) {
    if (await db.seriesGameExists(env.DB, date)) continue; // honors Skip + series dedup
    if (occupied.has(date)) continue; // a manual game already occupies this day
    const startsAt = zonedToUtcIso(`${date}T${RECURRING.time}`, tz);
    await db.createSeriesGame(
      env.DB,
      { seriesDate: date, startsAt, location: RECURRING.location, buyIn: RECURRING.buyIn, description: RECURRING.description },
      new Date().toISOString(),
    );
    occupied.add(date);
    created++;
    console.log(JSON.stringify({ msg: 'series game created', date, startsAt }));
  }
  return created;
}

/**
 * Cron job: remind subscribers about games starting within the lead window.
 * Regular games go to the whole subscribed list; a Special Players tournament
 * is invite-only, so its reminder goes ONLY to the invited players (the RSVP
 * roster of the season whose close attached this game). If no invites are
 * linked to a tournament game, nobody is reminded — better silent than leaking
 * an open invitation to the whole roster.
 */
export async function sendDueReminders(env: Env, now = new Date()): Promise<{ games: number; sent: number }> {
  const leadHours = Number(env.REMINDER_LEAD_HOURS || '24');
  const cutoff = new Date(now.getTime() + leadHours * 3600 * 1000);
  const games = await db.gamesDueForReminder(env.DB, now.toISOString(), cutoff.toISOString());
  if (games.length === 0) return { games: 0, sent: 0 };

  const phones = await db.listSubscribedPhones(env.DB);
  let sent = 0;
  for (const game of games) {
    let recipients = phones;
    if (game.is_tournament) {
      const season = (await db.listSeasons(env.DB)).find((s) => s.snapshot.gameId === game.id);
      const rsvps = season ? await db.rsvpsForSeason(env.DB, season.id) : [];
      recipients = rsvps.map((r) => r.member_phone);
      if (recipients.length === 0) {
        console.log(JSON.stringify({ msg: 'tournament reminder skipped — no linked invites', gameId: game.id }));
        await db.markReminderSent(env.DB, game.id);
        continue;
      }
    }
    const res = await broadcast(env, recipients, gameReminder(env, game));
    sent += res.sent;
    await db.markReminderSent(env.DB, game.id);
    console.log(JSON.stringify({ msg: 'reminder sent', gameId: game.id, tournament: !!game.is_tournament, ...res }));
  }
  return { games: games.length, sent };
}

/**
 * After attendance is recorded, award any newly-crossed promo thresholds and
 * text the member. Only subscribed members are texted/awarded.
 */
export async function awardRewardsForAttendees(env: Env, phones: string[], now: string): Promise<number> {
  const rules = await db.activeRewardRules(env.DB);
  if (rules.length === 0) return 0;

  let awarded = 0;
  for (const phone of phones) {
    const member = await db.getMember(env.DB, phone);
    if (!member || member.status !== 'SUBSCRIBED') continue;
    const visits = await db.attendanceCount(env.DB, phone);

    for (const rule of rules) {
      if (!crossedRewardThreshold(visits, rule.every_n_visits)) continue;
      if (await db.rewardAlreadyAwarded(env.DB, phone, rule.id, visits)) continue;

      await db.awardReward(env.DB, { phone, ruleId: rule.id, threshold: visits, text: rule.reward_text }, now);
      try {
        await sendSms(env, phone, promoMessage(env, rule.reward_text));
      } catch (err) {
        console.error(JSON.stringify({ msg: 'promo sms failed', phone, error: String(err) }));
      }
      awarded++;
    }
  }
  return awarded;
}
