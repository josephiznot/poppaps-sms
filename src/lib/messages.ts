/**
 * Inbound keyword parsing + outbound SMS copy.
 *
 * SMS is the player channel only (ADR-0005): JOIN / STOP / HELP + the one-step
 * name reply after JOIN. Compliance copy (program name, "Msg & data rates may
 * apply", STOP/HELP) is load-bearing — edit wording, keep those bits.
 */
import type { Env, Game } from '../types';
import { RECURRING, to12h } from './schedule';

export type Intent = 'OPT_IN' | 'OPT_OUT' | 'HELP' | 'CONFIRM' | 'UNKNOWN';

const OPT_IN_WORDS = new Set(['join', 'start', 'yes', 'subscribe', 'unstop', 'poker']);
const OPT_OUT_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout',
]);
const HELP_WORDS = new Set(['help', 'info']);
// Tournament-seat confirmation ("Reply IN to lock your seat"). Only meaningful
// for a member with a pending invite — the webhook falls back to UNKNOWN
// handling otherwise.
const CONFIRM_WORDS = new Set(['in', 'confirm', 'confirmed']);

/** Classify by first word, how carriers match keywords. */
export function parseIntent(body: string | undefined | null): Intent {
  const text = (body ?? '').trim().toLowerCase();
  const first = text.split(/\s+/)[0] ?? '';
  if (OPT_OUT_WORDS.has(first)) return 'OPT_OUT';
  if (OPT_IN_WORDS.has(first)) return 'OPT_IN';
  if (HELP_WORDS.has(first)) return 'HELP';
  // "IN" / "In!" / "confirm", plus the natural "I'm in" / "im in" / "I am in".
  if (CONFIRM_WORDS.has(first.replace(/[!.?]+$/, '')) || /^(i'?m|i am)\s+in\b/.test(text)) return 'CONFIRM';
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
    `Thanks ${name}! Games are every other week — cards fly ${to12h(RECURRING.time)} Central ` +
    `at Poppa P's. We'll text a reminder before each one, plus the occasional promo.` +
    `${link} Reply STOP to cancel.`
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
  const parts = [`${env.PROGRAM_NAME}: 🃏 Cards fly ${when} at ${game.location}.`];
  if (game.buy_in) parts.push(`Buy-in: ${game.buy_in}.`);
  if (game.description) parts.push(game.description);
  parts.push('Reply STOP to opt out.');
  return parts.join(' ');
}

/**
 * Top-8 invite. `confirmBy` is a host-written soft deadline ("Friday") baked
 * into the copy — the deadline lives in the message, not in code; the host
 * decides when it has passed and backfills from the leaderboard.
 */
export function tournamentInvite(env: Env, game: Game | null, confirmBy?: string): string {
  const head = `${env.PROGRAM_NAME}: 🏆 You made the Special Players tournament — our biggest cigar prizes of the season!`;
  const where = game ? `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}.` : 'Details to come.';
  const by = confirmBy ? ` by ${confirmBy}` : '';
  return `${head} ${where} Reply IN${by} to lock your seat — unclaimed seats go to the next player. Reply STOP to opt out.`;
}

/** Backfill invite to the next player on the closed season's leaderboard. */
export function seatOpenedInvite(env: Env, game: Game | null): string {
  const head = `${env.PROGRAM_NAME}: 🏆 A seat opened up in the Special Players tournament and you're next on the leaderboard!`;
  const where = game ? `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}.` : 'Details to come.';
  return `${head} ${where} Reply IN to claim your seat. Reply STOP to opt out.`;
}

/** Reply to IN — also re-sent if they confirm twice (harmless, reassuring). */
export function rsvpConfirmedMessage(env: Env, game: Game | null): string {
  const where = game
    ? `See you ${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}.`
    : `We'll text the details soon.`;
  return `${env.PROGRAM_NAME}: 🏆 Seat locked! ${where} Reply STOP to opt out.`;
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

/**
 * Format a calendar date (YYYY-MM-DD, e.g. from a date input) as a friendly,
 * unambiguous label for the invite copy, e.g. "Sunday, June 21". Parsed at UTC
 * so a date-only value never slips a day under time-zone conversion. Falls back
 * to the raw input if it isn't a YYYY-MM-DD date.
 */
export function formatConfirmBy(dateStr: string): string {
  const s = (dateStr ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(d);
}

/** Date only in the given time zone, e.g. "06/15/2026". */
export function formatDateOnly(iso: string, timeZone = 'America/Chicago'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}
