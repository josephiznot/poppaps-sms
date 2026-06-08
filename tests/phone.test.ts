import { describe, it, expect } from 'vitest';
import { toE164, formatUs } from '../src/lib/phone';

describe('toE164', () => {
  it('normalizes common US formats', () => {
    expect(toE164('(615) 695-1691')).toBe('+16156951691');
    expect(toE164('615-695-1691')).toBe('+16156951691');
    expect(toE164('6156951691')).toBe('+16156951691');
    expect(toE164('16156951691')).toBe('+16156951691');
    expect(toE164('+16156951691')).toBe('+16156951691');
  });

  it('rejects junk', () => {
    expect(toE164('')).toBeNull();
    expect(toE164('nope')).toBeNull();
    expect(toE164('12345')).toBeNull();
  });
});

describe('formatUs', () => {
  it('pretty-prints US E.164', () => {
    expect(formatUs('+16156951691')).toBe('(615) 695-1691');
  });
});
