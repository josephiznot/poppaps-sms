import { describe, it, expect } from 'vitest';
import { parseIntent } from '../src/lib/messages';

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
