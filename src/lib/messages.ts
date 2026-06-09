/**
 * Inbound keyword parsing + outbound SMS copy.
 *
 * SMS is the player channel only (ADR-0005): JOIN / STOP / HELP + the one-step
 * name reply after JOIN. Compliance copy (program name, "Msg & data rates may
 * apply", STOP/HELP) is load-bearing — edit wording, keep those bits.
 */
import type { Env, Game } from '../types';

export type Intent = 'OPT_IN' | 'OPT_OUT' | 'HELP' | 'UNKNOWN';

const OPT_IN_WORDS = new Set(['join', 'start', 'yes', 'subscribe', 'unstop', 'poker']);
const OPT_OUT_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout',
]);
const HELP_WORDS = new Set(['help', 'info']);

/** Classify by first word, how carriers match keywords. */
export function parseIntent(body: string | undefined | null): Intent {
  const first = (body ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (OPT_OUT_WORDS.has(first)) return 'OPT_OUT';
  if (OPT_IN_WORDS.has(first)) return 'OPT_IN';
  if (HELP_WORDS.has(first)) return 'HELP';
  return 'UNKNOWN';
}

/** Asked right after JOIN, to capture a display name. */
export function askNameMessage(env: Env): string {
  const terms = env.PUBLIC_BASE_URL ? ` Terms: ${env.PUBLIC_BASE_URL}/terms.` : '';
  return (
    `${env.PROGRAM_NAME}: You're in! 🃏 Reply with your first name + last initial ` +
    `(e.g. "Mike R") so we can put you on the standings. ` +
    `Recurring msgs; frequency varies. Msg & data rates may apply.${terms} ` +
    `Reply STOP to cancel, HELP for help.`
  );
}

export function nameConfirmedMessage(env: Env, name: string): string {
  const link = env.PUBLIC_BASE_URL ? ` Standings: ${env.PUBLIC_BASE_URL}/` : '';
  return (
    `Thanks ${name}! We'll text you a reminder before each game at Poppa P's, ` +
    `plus the occasional promo.${link} Reply STOP to cancel.`
  );
}

export function alreadyMemberMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: You're already on the list. Reply STOP to cancel, HELP for help.`;
}

export function optOutMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: You're unsubscribed and won't get more texts. Reply JOIN to opt back in.`;
}

export function helpMessage(env: Env): string {
  return (
    `${env.PROGRAM_NAME}: reminders + promos for poker at Poppa P's. ` +
    `Msg & data rates may apply. Reply STOP to cancel. Help: ${env.SUPPORT_CONTACT}.`
  );
}

export function unknownMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: Reply JOIN for game reminders, HELP for info, or STOP to unsubscribe.`;
}

export function gameReminder(env: Env, game: Game): string {
  const when = formatWhen(game.starts_at, env.TIMEZONE);
  const parts = [`${env.PROGRAM_NAME}: 🃏 Game ${when} at ${game.location}.`];
  if (game.buy_in) parts.push(`Buy-in: ${game.buy_in}.`);
  if (game.description) parts.push(game.description);
  parts.push('Reply STOP to opt out.');
  return parts.join(' ');
}

export function tournamentInvite(env: Env, game: Game | null): string {
  const head = `${env.PROGRAM_NAME}: 🏆 You made the Special Players tournament — our biggest cigar prizes of the season!`;
  if (game) {
    const when = formatWhen(game.starts_at, env.TIMEZONE);
    return `${head} ${when} at ${game.location}. Reply STOP to opt out.`;
  }
  return `${head} Details to come. Reply STOP to opt out.`;
}

export function promoMessage(env: Env, rewardText: string): string {
  return (
    `${env.PROGRAM_NAME}: 🎁 You've earned a ${rewardText}! ` +
    `Show this text at Poppa P's to redeem. Reply STOP to opt out.`
  );
}

/** Human-friendly local time, e.g. "Sat Jun 7, 7:00 PM CT". */
export function formatWhen(iso: string, timeZone = 'America/Chicago'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
