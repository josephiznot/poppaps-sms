/** Pure scoring logic (unit-tested; no I/O). */

/** Points by finishing place, top 5 only: 1st=5 … 5th=1, 6th+ = 0. */
export const PLACE_POINTS = [5, 4, 3, 2, 1] as const;

/** zeroBasedIndex 0 = 1st place. */
export function pointsForPlace(zeroBasedIndex: number): number {
  return PLACE_POINTS[zeroBasedIndex] ?? 0;
}

/** Card ranks for the standings badges, best first: 1st = A … 13th = 2. */
export const RANK_CARDS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'] as const;

/** Card label for a standings rank (zeroBasedIndex 0 = 1st place); null once the deck runs out (14th+). */
export function cardForRank(zeroBasedIndex: number): string | null {
  return RANK_CARDS[zeroBasedIndex] ?? null;
}

/** One attended game in a player's season history (LEFT-JOINed points may be null). */
export interface PlayerGameRow {
  is_tournament: number;
  points: number | null;
}

export interface SeasonStats {
  /** Games attended this season (tournaments included). */
  games: number;
  /** 1st-place finishes (5-point rows). */
  wins: number;
  /** % of attended games with points > 0, rounded to a whole number. */
  top5Rate: number;
  /** Season point total. */
  points: number;
}

/** Profile-page stat strip. Tournament rows count as games but never score points (D5). */
export function seasonStats(rows: PlayerGameRow[]): SeasonStats {
  const pts = rows.map((r) => (r.is_tournament ? 0 : (r.points ?? 0)));
  const games = rows.length;
  const scored = pts.filter((p) => p > 0).length;
  return {
    games,
    wins: pts.filter((p) => p === 5).length,
    top5Rate: games ? Math.round((scored / games) * 100) : 0,
    points: pts.reduce((sum, p) => sum + p, 0),
  };
}

/** True if a visit count has crossed a "every N" reward threshold. */
export function crossedRewardThreshold(visitCount: number, everyN: number): boolean {
  return everyN > 0 && visitCount > 0 && visitCount % everyN === 0;
}
