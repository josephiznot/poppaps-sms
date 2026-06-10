/**
 * Positive-only player badges for the public standings (pure; unit-tested).
 * Computed from attendance + scoring history over regular (non-tournament)
 * games. Deliberately NO negative/"cold" labels — a slump only ever surfaces
 * at the moment of redemption (the Comeback badge).
 */

export interface PlayedGame {
  gameId: string;
  /** True if the player finished in the top 5 (scored points) that night. */
  scored: boolean;
}

/**
 * Badges for one player.
 * - 🔥 Hot      — top-5 in their last 2+ played games.
 * - ⚡ Comeback — top-5 in their last played game after 4+ played games without.
 * - 🃏 Regular  — attended all of the venue's last 3 recorded games.
 */
export function computeBadges(played: PlayedGame[], lastGameIds: string[]): string[] {
  const badges: string[] = [];
  const n = played.length;

  if (n >= 2 && played[n - 1]!.scored && played[n - 2]!.scored) {
    badges.push('🔥 Hot');
  } else if (n >= 5 && played[n - 1]!.scored && played.slice(n - 5, n - 1).every((g) => !g.scored)) {
    badges.push('⚡ Comeback');
  }

  if (lastGameIds.length >= 3 && lastGameIds.every((id) => played.some((p) => p.gameId === id))) {
    badges.push('🃏 Regular');
  }
  return badges;
}

export interface HistoryRow {
  member_phone: string;
  game_id: string;
  starts_at: string;
  points: number;
}

/** Group raw history rows (chronological) into per-player badge results. */
export function badgesForAll(history: HistoryRow[]): Record<string, string[]> {
  const byPlayer = new Map<string, PlayedGame[]>();
  const gameOrder: string[] = [];
  const seenGames = new Set<string>();

  for (const row of history) {
    if (!seenGames.has(row.game_id)) {
      seenGames.add(row.game_id);
      gameOrder.push(row.game_id);
    }
    const list = byPlayer.get(row.member_phone) ?? [];
    list.push({ gameId: row.game_id, scored: row.points > 0 });
    byPlayer.set(row.member_phone, list);
  }

  const lastGameIds = gameOrder.slice(-3);
  const out: Record<string, string[]> = {};
  for (const [phone, played] of byPlayer) out[phone] = computeBadges(played, lastGameIds);
  return out;
}
