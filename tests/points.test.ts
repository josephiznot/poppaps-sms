import { describe, it, expect } from 'vitest';
import { pointsForPlace, crossedRewardThreshold } from '../src/lib/points';

describe('pointsForPlace', () => {
  it('awards 5·4·3·2·1 to the top five', () => {
    expect([0, 1, 2, 3, 4].map(pointsForPlace)).toEqual([5, 4, 3, 2, 1]);
  });
  it('awards 0 to 6th and beyond', () => {
    expect(pointsForPlace(5)).toBe(0);
    expect(pointsForPlace(10)).toBe(0);
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
