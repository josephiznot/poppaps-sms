import { describe, it, expect } from 'vitest';
import { pointsForPlace, crossedRewardThreshold, cardForRank } from '../src/lib/points';

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
