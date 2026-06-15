import { describe, it, expect } from 'vitest';
import { pointsForPlace, crossedRewardThreshold, cardForRank, seasonStats, placeOrdinal } from '../src/lib/points';

describe('pointsForPlace', () => {
  it('awards 5·4·3·2·1 to the top five', () => {
    expect([0, 1, 2, 3, 4].map(pointsForPlace)).toEqual([5, 4, 3, 2, 1]);
  });
  it('awards 0 to 6th and beyond', () => {
    expect(pointsForPlace(5)).toBe(0);
    expect(pointsForPlace(10)).toBe(0);
  });
});

describe('cardForRank', () => {
  it('maps 1st place to the Ace', () => {
    expect(cardForRank(0)).toBe('A');
  });
  it('runs the full deck down to the 2 at 13th place', () => {
    expect(cardForRank(4)).toBe('10');
    expect(cardForRank(12)).toBe('2');
  });
  it('returns null once the deck runs out (14th+)', () => {
    expect(cardForRank(13)).toBeNull();
    expect(cardForRank(20)).toBeNull();
  });
});

describe('placeOrdinal', () => {
  it('labels places 1..5', () => {
    expect([1, 2, 3, 4, 5].map(placeOrdinal)).toEqual(['1st', '2nd', '3rd', '4th', '5th']);
  });
  it('returns a dash for null/undefined/out-of-range', () => {
    expect(placeOrdinal(null)).toBe('—');
    expect(placeOrdinal(undefined)).toBe('—');
    expect(placeOrdinal(0)).toBe('—');
    expect(placeOrdinal(6)).toBe('—');
  });
});

describe('seasonStats', () => {
  it('returns zeros for an empty season', () => {
    expect(seasonStats([])).toEqual({ games: 0, wins: 0, top5Rate: 0, points: 0 });
  });

  it('computes games, wins, top-5 rate, and points from mixed results', () => {
    const rows = [
      { is_tournament: 0, points: 5 }, // win
      { is_tournament: 0, points: 3 }, // top-5
      { is_tournament: 0, points: null }, // attended, no points row
      { is_tournament: 0, points: 0 }, // attended, scored 0
    ];
    expect(seasonStats(rows)).toEqual({ games: 4, wins: 1, top5Rate: 50, points: 8 });
  });

  it('counts tournament rows as games but never as points', () => {
    const rows = [
      { is_tournament: 0, points: 5 },
      { is_tournament: 1, points: null }, // tournaments award no season points (D5)
      { is_tournament: 1, points: 5 }, // even a stray ledger row must not count
    ];
    expect(seasonStats(rows)).toEqual({ games: 3, wins: 1, top5Rate: 33, points: 5 });
  });
});

describe('crossedRewardThreshold', () => {
  it('fires on multiples of N', () => {
    expect(crossedRewardThreshold(5, 5)).toBe(true);
    expect(crossedRewardThreshold(10, 5)).toBe(true);
  });
  it('does not fire off-threshold or at zero visits', () => {
    expect(crossedRewardThreshold(4, 5)).toBe(false);
    expect(crossedRewardThreshold(0, 5)).toBe(false);
  });
});
