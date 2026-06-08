/** Pure scoring logic (unit-tested; no I/O). */

/** Points by finishing place, top 5 only: 1st=5 … 5th=1, 6th+ = 0. */
export const PLACE_POINTS = [5, 4, 3, 2, 1] as const;

/** zeroBasedIndex 0 = 1st place. */
export function pointsForPlace(zeroBasedIndex: number): number {
  return PLACE_POINTS[zeroBasedIndex] ?? 0;
}

/** True if a visit count has crossed a "every N" reward threshold. */
export function crossedRewardThreshold(visitCount: number, everyN: number): boolean {
  return everyN > 0 && visitCount > 0 && visitCount % everyN === 0;
}
