import { describe, it, expect } from 'vitest';
import { parseIntent, formatDateOnly, tournamentInvite, seatOpenedInvite, formatConfirmBy, gameReminder, nameConfirmedMessage, unknownMessage, rsvpDeclinedMessage } from '../src/lib/messages';
import type { Env, Game } from '../src/types';

describe('parseIntent', () => {
  it('detects opt-in keywords', () => {
    for (const w of ['JOIN', 'join', 'Start', 'YES', 'subscribe']) {
      expect(parseIntent(w)).toBe('OPT_IN');
    }
  });

  it('detects opt-out keywords (carrier-standard)', () => {
    for (const w of ['STOP', 'stop please', 'UNSUBSCRIBE', 'cancel', 'QUIT', 'end']) {
      expect(parseIntent(w)).toBe('OPT_OUT');
    }
  });

  it('detects help keywords', () => {
    expect(parseIntent('HELP')).toBe('HELP');
    expect(parseIntent('info')).toBe('HELP');
  });

  it('treats a name reply as UNKNOWN (handled as name capture in the webhook)', () => {
    expect(parseIntent('Mike R')).toBe('UNKNOWN');
    expect(parseIntent('')).toBe('UNKNOWN');
    expect(parseIntent(undefined)).toBe('UNKNOWN');
  });

  it('classifies by the first word', () => {
    expect(parseIntent('stop spamming me')).toBe('OPT_OUT');
    expect(parseIntent('join the fun')).toBe('OPT_IN');
  });

  it('detects tournament-seat confirmations (CALL/IN and synonyms)', () => {
    for (const w of ['CALL', 'call', 'IN', 'in', 'In!', 'confirm', 'CONFIRMED', "I'm in", 'im in', 'I am in!']) {
      expect(parseIntent(w)).toBe('CONFIRM');
    }
  });

  it('detects tournament-seat declines (FOLD/OUT and synonyms)', () => {
    for (const w of ['FOLD', 'fold', 'OUT', 'out', 'No', 'nope', 'pass', 'decline', "can't", 'cant', "I'm out"]) {
      expect(parseIntent(w)).toBe('DECLINE');
    }
  });

  it('does not confuse confirmations/declines with similar words', () => {
    expect(parseIntent('info')).toBe('HELP'); // 'info' ≠ 'in'
    expect(parseIntent('Ingrid B')).toBe('UNKNOWN'); // name reply, not IN
    expect(parseIntent('inside straight')).toBe('UNKNOWN');
    expect(parseIntent('Nolan P')).toBe('UNKNOWN'); // name reply, not "no"
    expect(parseIntent('cancel')).toBe('OPT_OUT'); // carrier word wins over decline
  });

  it('keeps carrier keywords winning over confirmation', () => {
    expect(parseIntent('stop')).toBe('OPT_OUT');
    expect(parseIntent('yes')).toBe('OPT_IN'); // YES stays opt-in; webhook special-cases invitees
  });
});

describe('formatConfirmBy', () => {
  it('formats a YYYY-MM-DD date as a friendly label with no time-zone slip', () => {
    expect(formatConfirmBy('2026-06-21')).toBe('Sunday, June 21');
    expect(formatConfirmBy('2026-12-01')).toBe('Tuesday, December 1');
  });
  it('falls back to the raw input when it is not a calendar date', () => {
    expect(formatConfirmBy('Friday')).toBe('Friday');
    expect(formatConfirmBy('')).toBe('');
  });
});

describe('tournament invite copy', () => {
  const env = { PROGRAM_NAME: "Poppa P's Poker Night", TIMEZONE: 'America/Chicago' } as Env;
  const game = { starts_at: '2026-06-20T23:30:00.000Z', location: "Poppa P's" } as Game;

  it('asks for CALL/FOLD with the host deadline baked into the copy', () => {
    const msg = tournamentInvite(env, game, 'Sunday, June 21');
    expect(msg).toContain('Reply CALL by Sunday, June 21 to grab your seat');
    expect(msg).toContain('FOLD to pass');
    expect(msg).toContain("at Poppa P's");
    expect(msg).toContain('Reply STOP'); // compliance line stays
  });

  it('omits the deadline when the host leaves it blank', () => {
    expect(tournamentInvite(env, game)).toContain('Reply CALL to grab your seat');
    expect(tournamentInvite(env, null)).toContain('Details to come.');
  });

  it('backfill invite asks for CALL/FOLD and keeps STOP', () => {
    const msg = seatOpenedInvite(env, game);
    expect(msg).toContain('seat opened up');
    expect(msg).toContain('Reply CALL to grab your seat');
    expect(msg).toContain('FOLD to pass');
    expect(msg).toContain('Reply STOP');
  });

  it('decline reply frees the seat but keeps them subscribed', () => {
    const msg = rsvpDeclinedMessage(env);
    expect(msg).toContain('opened your seat');
    expect(msg).toContain('still on the list'); // not an unsubscribe
    expect(msg).toContain('Reply STOP');
  });
});

describe('game reminder copy', () => {
  const env = { PROGRAM_NAME: "Poppa P's Poker Night", TIMEZONE: 'America/Chicago' } as Env;
  // 6:30 PM CDT on Mon Jun 15 = 23:30 UTC same day.
  const game = { starts_at: '2026-06-15T23:30:00.000Z', location: "Poppa P's Smoke Shoppe & Lounge" } as Game;

  it('says "Cards fly" and keeps the location + STOP line', () => {
    const msg = gameReminder(env, game);
    expect(msg).toContain('Cards fly');
    expect(msg).toContain("Poppa P's Smoke Shoppe & Lounge");
    expect(msg).toContain('Reply STOP to opt out.');
  });
});

describe('unknown (catch-all) copy', () => {
  const env = { PROGRAM_NAME: "Poppa P's Poker Night" } as Env;

  it('nudges a non-subscriber to JOIN', () => {
    const msg = unknownMessage(env, false);
    expect(msg).toContain('Reply JOIN');
    expect(msg).toContain('STOP');
  });

  it('does not tell an already-subscribed member to JOIN', () => {
    const msg = unknownMessage(env, true);
    expect(msg).not.toContain('JOIN');
    expect(msg).toContain('already on the list');
    expect(msg).toContain('HELP');
    expect(msg).toContain('STOP');
  });
});

describe('welcome (name-confirmed) copy', () => {
  const env = { PROGRAM_NAME: "Poppa P's Poker Night", TIMEZONE: 'America/Chicago' } as Env;

  it('states the standard 6:30 PM Central start and keeps the STOP line', () => {
    const msg = nameConfirmedMessage(env, 'Smoke T');
    expect(msg).toContain('6:30 PM');
    expect(msg).toContain('Central');
    expect(msg).toContain('Reply STOP to cancel.');
  });
});

describe('formatDateOnly', () => {
  it('formats MM/DD/YYYY in the given time zone', () => {
    // 6:30 PM CDT on Mon Jun 15 = 23:30 UTC same day.
    expect(formatDateOnly('2026-06-15T23:30:00.000Z', 'America/Chicago')).toBe('06/15/2026');
  });

  it('uses the local date when UTC has rolled to the next day', () => {
    // 02:00 UTC Jun 16 is still 9:00 PM CDT Jun 15.
    expect(formatDateOnly('2026-06-16T02:00:00.000Z', 'America/Chicago')).toBe('06/15/2026');
  });
});
