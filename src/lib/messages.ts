/**
 * Inbound keyword parsing + outbound SMS copy.
 *
 * SMS is the player channel only (ADR-0005): JOIN / STOP / HELP + the one-step
 * name reply after JOIN. Compliance copy (program name, "Msg & data rates may
 * apply", STOP/HELP) is load-bearing — edit wording, keep those bits.
 */
import type { Env, Game } from '../types';
import { RECURRING, to12h } from './schedule';

export type Intent = 'OPT_IN' | 'OPT_OUT' | 'HELP' | 'CONFIRM' | 'DECLINE' | 'UNKNOWN';

const OPT_IN_WORDS = new Set(['join', 'start', 'yes', 'subscribe', 'unstop', 'poker']);
const OPT_OUT_WORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout',
]);
const HELP_WORDS = new Set(['help', 'info']);
// Tournament-seat RSVP. CALL/FOLD are the advertised poker keywords; plain
// IN/YES and OUT/NO are accepted as synonyms so nobody's RSVP bounces. Both are
// only meaningful for a member with a pending invite — the webhook falls back to
// UNKNOWN handling otherwise (so a stray "no" from a non-invitee isn't a decline).
const CONFIRM_WORDS = new Set(['call', 'in', 'confirm', 'confirmed']);
const DECLINE_WORDS = new Set(['fold', 'out', 'no', 'nope', 'pass', 'decline', 'cant', "can't", 'cannot']);

/** Classify by first word, how carriers match keywords. */
export function parseIntent(body: string | undefined | null): Intent {
  const text = (body ?? '').trim().toLowerCase();
  const first = text.split(/\s+/)[0] ?? '';
  const firstClean = first.replace(/[!.?,]+$/, '');
  if (OPT_OUT_WORDS.has(first)) return 'OPT_OUT';
  if (OPT_IN_WORDS.has(first)) return 'OPT_IN';
  if (HELP_WORDS.has(first)) return 'HELP';
  // "CALL" / "IN" / "In!" / "confirm", plus the natural "I'm in" / "I am in".
  if (CONFIRM_WORDS.has(firstClean) || /^(i'?m|i am)\s+in\b/.test(text)) return 'CONFIRM';
  // "FOLD" / "OUT" / "no" / "pass", plus "can't make it" / "I'm out".
  if (DECLINE_WORDS.has(firstClean) || /^(i'?m|i am)\s+out\b/.test(text)) return 'DECLINE';
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

export function welcomeBackMessage(env: Env, name: string): string {
  const link = env.PUBLIC_BASE_URL ? ` Standings: ${env.PUBLIC_BASE_URL}/` : '';
  return (
    `${env.PROGRAM_NAME}: Welcome back, ${name}! You're subscribed again for game reminders ` +
    `and occasional promos. We kept your name and standings history.${link} Reply STOP to cancel.`
  );
}

export function rejoinMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: To rejoin game reminders, text START or UNSTOP. Reply HELP for info.`;
}

export function helpMessage(env: Env): string {
  return (
    `${env.PROGRAM_NAME}: reminders + promos for poker at Poppa P's. ` +
    `Msg & data rates may apply. Reply STOP to cancel. Help: ${env.SUPPORT_CONTACT}.`
  );
}

/**
 * Catch-all reply for unrecognized inbound text. Tailored by subscription:
 * an already-subscribed member isn't told to JOIN (they're in); a non-member
 * or opted-out number is. STOP + HELP are offered to everyone (compliance).
 */
export function unknownMessage(env: Env, subscribed = false, optedOut = false): string {
  if (subscribed) {
    return `${env.PROGRAM_NAME}: You're already on the list for game reminders. Reply HELP for info or STOP to unsubscribe.`;
  }
  if (optedOut) return rejoinMessage(env);
  return `${env.PROGRAM_NAME}: Reply JOIN for game reminders, HELP for info, or STOP to unsubscribe.`;
}

export function gameReminder(env: Env, game: Game): string {
  const when = formatWhen(game.starts_at, env.TIMEZONE);
  // Tournament reminders only ever reach the invited roster (lib/jobs.ts), so
  // "your seat" is always true — the distinct copy keeps an invitee from
  // mistaking the night for a regular open game.
  const parts = [
    game.is_tournament
      ? `${env.PROGRAM_NAME}: 🏆 Special Players tournament — your seat's waiting! Cards fly ${when} at ${game.location}. Invitation-only, not a regular game night.`
      : `${env.PROGRAM_NAME}: 🃏 Cards fly ${when} at ${game.location}.`,
  ];
  if (game.buy_in) parts.push(`Buy-in: ${game.buy_in}.`);
  if (game.description) parts.push(game.description);
  parts.push('Reply STOP to opt out.');
  return parts.join(' ');
}

/**
 * Top-8 invite. CALL / FOLD are the advertised RSVP keywords (IN / OUT also
 * work). `confirmBy` is a host-picked deadline baked into the copy — it lives in
 * the message, not in code; the host decides when it has passed and backfills.
 */
export function tournamentInvite(env: Env, game: Game | null, confirmBy?: string): string {
  const head = `${env.PROGRAM_NAME}: 🏆 You made the Special Players tournament — our biggest cigar prizes of the season!`;
  const where = game ? `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}.` : 'Details to come.';
  const by = confirmBy ? ` by ${confirmBy}` : '';
  return `${head} ${where} Reply CALL${by} to grab your seat or FOLD to pass — unclaimed seats go to the next player. Reply STOP to opt out.`;
}

/** Backfill invite to the next player on the closed season's leaderboard. */
export function seatOpenedInvite(env: Env, game: Game | null): string {
  const head = `${env.PROGRAM_NAME}: 🏆 A seat opened up in the Special Players tournament and you're next on the leaderboard!`;
  const where = game ? `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}.` : 'Details to come.';
  return `${head} ${where} Reply CALL to grab your seat or FOLD to pass. Reply STOP to opt out.`;
}

/** Automatic qualification invite. Deadlines are stored as instants; the copy
 * derives its label from the same value shown in the admin UI. */
export function automaticTournamentInvite(env: Env, game: Game, responseDeadline: string, replacement = false): string {
  const lead = replacement
    ? `${env.PROGRAM_NAME}: 🏆 A Special Players seat opened and you're next on the frozen leaderboard!`
    : `${env.PROGRAM_NAME}: 🏆 You qualified for the Special Players tournament!`;
  return (
    `${lead} ${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}. ` +
    `Reply CALL by ${formatWhen(responseDeadline, env.TIMEZONE)} to reserve your seat or FOLD to pass. ` +
    `Invitation-only, not a regular game night. Reply STOP to opt out.`
  );
}

export function tournamentDateChangedMessage(env: Env, game: Game, responseDeadline?: string): string {
  const deadline = responseDeadline ? ` Reply CALL by ${formatWhen(responseDeadline, env.TIMEZONE)} to confirm or FOLD to pass.` : '';
  return (
    `${env.PROGRAM_NAME}: 🏆 Special Players tournament update — cards now fly ` +
    `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}. Your current RSVP still applies.` +
    `${deadline} Reply STOP to opt out.`
  );
}

export function tournamentCancelledMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: The upcoming Special Players tournament has been cancelled. Reply STOP to opt out.`;
}

const dealerPlayerDeadlineText = (env: Env, playerDeadline: string, now: Date): string =>
  playerDeadline > now.toISOString()
    ? `Player invitations are open through ${formatWhen(playerDeadline, env.TIMEZONE)}.`
    : `The player response deadline was ${formatWhen(playerDeadline, env.TIMEZONE)}.`;

export function designatedDealerTournamentNotice(env: Env, game: Game, playerDeadline: string, now = new Date()): string {
  return (
    `${env.PROGRAM_NAME}: You're the designated dealer for the Special Players tournament ` +
    `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}. No RSVP is needed for the dealer role, ` +
    `and it does not take a player seat. ${dealerPlayerDeadlineText(env, playerDeadline, now)} ` +
    `Reply STOP to opt out.`
  );
}

export function designatedDealerTournamentReminder(env: Env, game: Game): string {
  return (
    `${env.PROGRAM_NAME}: 🏆 Reminder — you're the designated dealer for the Special Players tournament ` +
    `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}. No RSVP is needed; this is the dealer role, not a player seat. ` +
    `Reply STOP to opt out.`
  );
}

export function designatedDealerDateChangedMessage(env: Env, game: Game, playerDeadline: string, now = new Date()): string {
  return (
    `${env.PROGRAM_NAME}: Designated dealer update — the Special Players tournament now starts ` +
    `${formatWhen(game.starts_at, env.TIMEZONE)} at ${game.location}. No RSVP is needed. ` +
    `${dealerPlayerDeadlineText(env, playerDeadline, now)} Reply STOP to opt out.`
  );
}

export function designatedDealerTournamentCancelledMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: The Special Players tournament you were scheduled to deal has been cancelled. Reply STOP to opt out.`;
}

export function tournamentOfferExpiredMessage(env: Env): string {
  return `${env.PROGRAM_NAME}: That Special Players seat is no longer available. You're still on the regular game-reminder list. Reply STOP to opt out.`;
}

/** Reply to FOLD/decline — frees the seat but keeps them subscribed to reminders. */
export function rsvpDeclinedMessage(env: Env): string {
  return (
    `${env.PROGRAM_NAME}: 👍 No problem — we've opened your seat for the next player. ` +
    `You're still on the list for game reminders. Reply STOP to opt out.`
  );
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
