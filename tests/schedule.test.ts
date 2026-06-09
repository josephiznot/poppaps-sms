import { describe, it, expect } from 'vitest';
import { addDaysToKey, seriesDatesBetween } from '../src/lib/schedule';

describe('addDaysToKey', () => {
  it('adds days across month boundaries', () => {
    expect(addDaysToKey('2026-06-15', 14)).toBe('2026-06-29');
    expect(addDaysToKey('2026-06-29', 14)).toBe('2026-07-13');
  });
});

describe('seriesDatesBetween', () => {
  const anchor = '2026-06-15';

  it('returns the next occurrence within a short window', () => {
    expect(seriesDatesBetween(anchor, 14, '2026-06-08', '2026-06-24')).toEqual(['2026-06-15']);
  });

  it('returns every-14-day occurrences within a range', () => {
    expect(seriesDatesBetween(anchor, 14, '2026-06-15', '2026-07-15')).toEqual([
      '2026-06-15',
      '2026-06-29',
      '2026-07-13',
    ]);
  });

  it('skips occurrences before the window start', () => {
    expect(seriesDatesBetween(anchor, 14, '2026-06-20', '2026-07-20')).toEqual([
      '2026-06-29',
      '2026-07-13',
    ]);
  });

  it('is empty when the anchor is past the window', () => {
    expect(seriesDatesBetween(anchor, 14, '2026-05-01', '2026-06-10')).toEqual([]);
  });
});
