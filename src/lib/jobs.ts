/** Cron + side-effect logic: send reminders, evaluate attendance rewards. */
import type { Env, Game } from '../types';
import * as db from './db';
import { sendSms } from './twilio';
import { gameReminder, promoMessage } from './messages';
import { drainOutbox, queueDelivery } from './delivery';
import { tournamentOffers, getTournamentPlan } from './tournament-db';
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
 * is invite-only, so its player reminder goes only to current offers. The
 * designated host/dealer has a current player offer and follows this same path.
 */
export async function sendDueReminders(env: Env, now = new Date()): Promise<{ games: number; queued: number }> {
  const leadHours = Number(env.REMINDER_LEAD_HOURS || '24');
  const cutoff = new Date(now.getTime() + leadHours * 3600 * 1000);
  const games = await db.gamesDueForReminder(env.DB, now.toISOString(), cutoff.toISOString());

  const phones = await db.listSubscribedPhones(env.DB);
  let queued = 0;
  for (const game of games) {
    let recipients: Array<{ phone: string; offerId: string | null }> = phones.map((phone) => ({ phone, offerId: null }));
    let planId: string | null = null;
    let scheduleVersion = 1;
    if (game.is_tournament) {
      const found = await env.DB
        .prepare("SELECT id FROM tournament_plans WHERE game_id=? AND status='ACTIVE'")
        .bind(game.id)
        .first<{ id: string }>();
      const plan = found ? await getTournamentPlan(env.DB, found.id) : null;
      const offers = plan ? await tournamentOffers(env.DB, plan.id) : [];
      const subscribed = new Set(phones);
      recipients = offers
        .filter((offer) => (offer.state === 'ACTIVE' || offer.state === 'CONFIRMED') && subscribed.has(offer.member_phone))
        .map((offer) => ({ phone: offer.member_phone, offerId: offer.id }));
      planId = plan?.id ?? null;
      scheduleVersion = plan?.schedule_version ?? 1;
      if (recipients.length === 0) {
        console.log(JSON.stringify({ msg: 'tournament reminder skipped — no linked invites', gameId: game.id }));
        continue;
      }
    }
    const body = gameReminder(env, game);
    for (const recipient of recipients) {
      await queueDelivery(env.DB, {
        logicalKey: `game:${game.id}:reminder:v${scheduleVersion}`,
        recipient: recipient.phone,
        kind: game.is_tournament ? 'TOURNAMENT_REMINDER' : 'REGULAR_REMINDER',
        body,
        now: now.toISOString(),
        planId,
        gameId: game.id,
        offerId: recipient.offerId,
        version: scheduleVersion,
        expiresAt: game.starts_at,
      });
      queued++;
    }
    if (planId) {
      await env.DB
        .prepare(
          `UPDATE games SET reminder_sent=1 WHERE id=? AND starts_at=?
           AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND schedule_version=?)`,
        )
        .bind(game.id, game.starts_at, planId, scheduleVersion)
        .run();
    } else {
      await env.DB.prepare('UPDATE games SET reminder_sent=1 WHERE id=? AND starts_at=?').bind(game.id, game.starts_at).run();
    }
    console.log(JSON.stringify({ msg: 'reminders queued', gameId: game.id, tournament: !!game.is_tournament, queued: recipients.length }));
  }

  // Tournament reminders are per offer/recipient. Reconcile them on every due
  // tick so a current offer that was unsubscribed during the first batch can
  // receive its one reminder after consent resumes. The logical key remains
  // schedule-versioned and unique per recipient, so this cannot duplicate work.
  const duePlans = await env.DB
    .prepare(
      `SELECT p.id AS plan_id,p.schedule_version,g.*
       FROM tournament_plans p JOIN games g ON g.id=p.game_id
       WHERE p.status='ACTIVE' AND g.is_tournament=1 AND g.cancelled=0
         AND g.starts_at>=? AND g.starts_at<=?`,
    )
    .bind(now.toISOString(), cutoff.toISOString())
    .all<Game & { plan_id: string; schedule_version: number }>();
  const subscribed = new Set(phones);
  for (const plan of duePlans.results ?? []) {
    const offers = await tournamentOffers(env.DB, plan.plan_id);
    for (const offer of offers.filter(
      (row) => ['ACTIVE', 'CONFIRMED'].includes(row.state) && subscribed.has(row.member_phone),
    )) {
      const logicalKey = `game:${plan.id}:reminder:v${plan.schedule_version}`;
      const existing = await env.DB
        .prepare('SELECT id FROM sms_deliveries WHERE logical_key=? AND recipient=?')
        .bind(logicalKey, offer.member_phone)
        .first<{ id: string }>();
      await queueDelivery(env.DB, {
        logicalKey,
        recipient: offer.member_phone,
        kind: 'TOURNAMENT_REMINDER',
        body: gameReminder(env, plan),
        now: now.toISOString(),
        planId: plan.plan_id,
        gameId: plan.id,
        offerId: offer.id,
        version: plan.schedule_version,
        expiresAt: plan.starts_at,
      });
      if (!existing) queued++;
    }
  }
  return { games: games.length, queued };
}

export { drainOutbox };

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
