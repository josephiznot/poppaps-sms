/** Cron + side-effect logic: send reminders, evaluate attendance rewards. */
import type { Env } from '../types';
import * as db from './db';
import { sendSms } from './twilio';
import { gameReminder, promoMessage } from './messages';
import { crossedRewardThreshold } from './points';

/** Send a message to many phones sequentially (10DLC is ~1 msg/sec). */
export async function broadcast(env: Env, phones: string[], message: string): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const phone of phones) {
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

/** Cron job: remind subscribers about games starting within the lead window. */
export async function sendDueReminders(env: Env, now = new Date()): Promise<{ games: number; sent: number }> {
  const leadHours = Number(env.REMINDER_LEAD_HOURS || '24');
  const cutoff = new Date(now.getTime() + leadHours * 3600 * 1000);
  const games = await db.gamesDueForReminder(env.DB, now.toISOString(), cutoff.toISOString());
  if (games.length === 0) return { games: 0, sent: 0 };

  const phones = await db.listSubscribedPhones(env.DB);
  let sent = 0;
  for (const game of games) {
    const res = await broadcast(env, phones, gameReminder(env, game));
    sent += res.sent;
    await db.markReminderSent(env.DB, game.id);
    console.log(JSON.stringify({ msg: 'reminder sent', gameId: game.id, ...res }));
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
