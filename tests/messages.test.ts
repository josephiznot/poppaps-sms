import { describe, it, expect } from 'vitest';
import { parseIntent, formatDateOnly } from '../src/lib/messages';

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
