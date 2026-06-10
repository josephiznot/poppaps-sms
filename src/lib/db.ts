/** D1 data access. All SQL lives here; routes/jobs call these. */
import type { Member, Game, StandingRow, AwardedReward } from '../types';

const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export async function getMember(db: D1Database, phone: string): Promise<Member | null> {
  return db.prepare('SELECT * FROM members WHERE phone = ?').bind(phone).first<Member>();
}

/** Idempotent opt-in. Returns whether we should ask for a name / they were already in. */
export async function joinMember(
  db: D1Database,
  phone: string,
  source: string,
  now: string,
): Promise<{ askName: boolean; alreadySubscribed: boolean }> {
  const existing = await getMember(db, phone);
  const hasName = !!existing?.display_name;
  const alreadySubscribed = existing?.status === 'SUBSCRIBED' && hasName;
  const awaiting = hasName ? 0 : 1;

  if (existing) {
    await db
      .prepare(
        `UPDATE members SET status='SUBSCRIBED', opted_in_at=?, updated_at=?,
         awaiting_name=? WHERE phone=?`,
      )
      .bind(now, now, awaiting, phone)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO members (phone, status, awaiting_name, source, opted_in_at, created_at, updated_at)
         VALUES (?, 'SUBSCRIBED', 1, ?, ?, ?, ?)`,
      )
      .bind(phone, source, now, now, now)
      .run();
  }
  return { askName: !hasName, alreadySubscribed };
}

export async function setMemberName(db: D1Database, phone: string, name: string, now: string): Promise<void> {
  await db
    .prepare('UPDATE members SET display_name=?, awaiting_name=0, updated_at=? WHERE phone=?')
    .bind(name, now, phone)
    .run();
}

export async function optOutMember(db: D1Database, phone: string, now: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO members (phone, status, awaiting_name, opted_out_at, created_at, updated_at)
       VALUES (?, 'UNSUBSCRIBED', 0, ?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET status='UNSUBSCRIBED', awaiting_name=0,
         opted_out_at=excluded.opted_out_at, updated_at=excluded.updated_at`,
    )
    .bind(phone, now, now, now)
    .run();
}

export async function updateDisplayName(db: D1Database, phone: string, name: string, now: string): Promise<void> {
  await db
    .prepare('UPDATE members SET display_name=?, updated_at=? WHERE phone=?')
    .bind(name, now, phone)
    .run();
}

export async function listSubscribedPhones(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT phone FROM members WHERE status='SUBSCRIBED'").all<{ phone: string }>();
  return (r.results ?? []).map((x) => x.phone);
}

export async function listMembers(db: D1Database): Promise<Member[]> {
  const r = await db.prepare('SELECT * FROM members ORDER BY created_at DESC').all<Member>();
  return r.results ?? [];
}

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export async function createGame(
  db: D1Database,
  g: { starts_at: string; location: string; is_tournament: boolean; description?: string; buy_in?: string },
  now: string,
): Promise<string> {
  const id = uid();
  await db
    .prepare(
      `INSERT INTO games (id, starts_at, location, is_tournament, description, buy_in, reminder_sent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .bind(id, g.starts_at, g.location, g.is_tournament ? 1 : 0, g.description ?? null, g.buy_in ?? null, now)
    .run();
  return id;
}

export async function getGame(db: D1Database, id: string): Promise<Game | null> {
  return db.prepare('SELECT * FROM games WHERE id = ?').bind(id).first<Game>();
}

export async function listGames(db: D1Database): Promise<Game[]> {
  const r = await db.prepare('SELECT * FROM games ORDER BY starts_at DESC').all<Game>();
  return r.results ?? [];
}

export async function gamesDueForReminder(db: D1Database, nowIso: string, cutoffIso: string): Promise<Game[]> {
  const r = await db
    .prepare('SELECT * FROM games WHERE reminder_sent=0 AND cancelled=0 AND starts_at >= ? AND starts_at <= ?')
    .bind(nowIso, cutoffIso)
    .all<Game>();
  return r.results ?? [];
}

export async function markReminderSent(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE games SET reminder_sent=1 WHERE id=?').bind(id).run();
}

/** True if an auto-scheduled game already exists for this recurring date. */
export async function seriesGameExists(db: D1Database, seriesDate: string): Promise<boolean> {
  const r = await db.prepare('SELECT COUNT(*) AS c FROM games WHERE series_date=?').bind(seriesDate).first<{ c: number }>();
  return (r?.c ?? 0) > 0;
}

export async function createSeriesGame(
  db: D1Database,
  g: { seriesDate: string; startsAt: string; location: string; buyIn?: string; description?: string },
  now: string,
): Promise<string> {
  const id = uid();
  await db
    .prepare(
      `INSERT INTO games (id, starts_at, location, is_tournament, description, buy_in, reminder_sent, cancelled, series_date, created_at)
       VALUES (?, ?, ?, 0, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(series_date) DO NOTHING`,
    )
    .bind(id, g.startsAt, g.location, g.description ?? null, g.buyIn ?? null, g.seriesDate, now)
    .run();
  return id;
}

/** Skip/cancel a game — kept (not deleted) so the series won't regenerate it. */
export async function cancelGame(db: D1Database, id: string): Promise<void> {
  await db.prepare('UPDATE games SET cancelled=1 WHERE id=?').bind(id).run();
}

/** Hard-delete a game and its points + attendance (atomic) — to clean up dupes. */
export async function deleteGame(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM points_ledger WHERE game_id = ?').bind(id),
    db.prepare('DELETE FROM attendance WHERE game_id = ?').bind(id),
    db.prepare('DELETE FROM games WHERE id = ?').bind(id),
  ]);
}

/** Toggle a game's tournament flag (a label only — does not affect seasons). */
export async function setGameTournament(db: D1Database, id: string, isTournament: boolean): Promise<void> {
  await db.prepare('UPDATE games SET is_tournament=? WHERE id=?').bind(isTournament ? 1 : 0, id).run();
}

// ---------------------------------------------------------------------------
// Points / seasons
// ---------------------------------------------------------------------------

export async function lastSeasonClose(db: D1Database): Promise<string> {
  const r = await db.prepare('SELECT MAX(closed_at) AS c FROM seasons').first<{ c: string | null }>();
  return r?.c ?? '';
}

export async function addPoints(
  db: D1Database,
  memberPhone: string,
  gameId: string,
  points: number,
  now: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO points_ledger (id, member_phone, game_id, points, awarded_at) VALUES (?, ?, ?, ?, ?)')
    .bind(uid(), memberPhone, gameId, points, now)
    .run();
}

export async function gameHasResults(db: D1Database, gameId: string): Promise<boolean> {
  const r = await db.prepare('SELECT COUNT(*) AS c FROM points_ledger WHERE game_id=?').bind(gameId).first<{ c: number }>();
  return (r?.c ?? 0) > 0;
}

export async function standings(db: D1Database, sinceIso: string): Promise<StandingRow[]> {
  const r = await db
    .prepare(
      `SELECT p.member_phone AS phone, m.display_name AS display_name,
              SUM(p.points) AS total, MAX(p.awarded_at) AS last_award
       FROM points_ledger p
       LEFT JOIN members m ON m.phone = p.member_phone
       WHERE p.awarded_at > ?
       GROUP BY p.member_phone
       HAVING total > 0
       ORDER BY total DESC, last_award ASC`,
    )
    .bind(sinceIso)
    .all<StandingRow>();
  return r.results ?? [];
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export async function markAttendance(db: D1Database, memberPhone: string, gameId: string, now: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO attendance (id, member_phone, game_id, created_at) VALUES (?, ?, ?, ?)')
    .bind(uid(), memberPhone, gameId, now)
    .run();
}

export async function attendanceCount(db: D1Database, memberPhone: string): Promise<number> {
  const r = await db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE member_phone=?').bind(memberPhone).first<{ c: number }>();
  return r?.c ?? 0;
}

export async function attendeesForGame(db: D1Database, gameId: string): Promise<string[]> {
  const r = await db.prepare('SELECT member_phone FROM attendance WHERE game_id=?').bind(gameId).all<{ member_phone: string }>();
  return (r.results ?? []).map((x) => x.member_phone);
}

/**
 * Chronological attendance + scoring history over regular (non-tournament,
 * non-cancelled) games — feeds the public badge computation (lib/badges.ts).
 */
export async function attendanceHistory(
  db: D1Database,
): Promise<Array<{ member_phone: string; game_id: string; starts_at: string; points: number }>> {
  const r = await db
    .prepare(
      `SELECT a.member_phone, a.game_id, g.starts_at, COALESCE(p.points, 0) AS points
       FROM attendance a
       JOIN games g ON g.id = a.game_id
       LEFT JOIN points_ledger p ON p.game_id = a.game_id AND p.member_phone = a.member_phone
       WHERE g.cancelled = 0 AND g.is_tournament = 0
       ORDER BY g.starts_at ASC`,
    )
    .all<{ member_phone: string; game_id: string; starts_at: string; points: number }>();
  return r.results ?? [];
}

/** Per-member games-attended counts, as { phone: count }. */
export async function attendanceCounts(db: D1Database): Promise<Record<string, number>> {
  const r = await db
    .prepare('SELECT member_phone, COUNT(*) AS n FROM attendance GROUP BY member_phone')
    .all<{ member_phone: string; n: number }>();
  const out: Record<string, number> = {};
  for (const row of r.results ?? []) out[row.member_phone] = row.n;
  return out;
}

// ---------------------------------------------------------------------------
// Editing a recorded game — re-entry replaces that game's result wholesale
// (a deliberate, scoped exception to the append-only ledger; ADR-0002).
// ---------------------------------------------------------------------------

/** The points rows for one game (used to prefill the edit form). */
export async function pointsForGame(db: D1Database, gameId: string): Promise<Array<{ member_phone: string; points: number }>> {
  const r = await db
    .prepare('SELECT member_phone, points FROM points_ledger WHERE game_id=? ORDER BY points DESC')
    .bind(gameId)
    .all<{ member_phone: string; points: number }>();
  return r.results ?? [];
}

export async function clearGameResults(db: D1Database, gameId: string): Promise<void> {
  await db.prepare('DELETE FROM points_ledger WHERE game_id=?').bind(gameId).run();
}

export async function clearAttendanceForGame(db: D1Database, gameId: string): Promise<void> {
  await db.prepare('DELETE FROM attendance WHERE game_id=?').bind(gameId).run();
}

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

export async function closeSeason(db: D1Database, snapshot: unknown, now: string): Promise<void> {
  await db
    .prepare('INSERT INTO seasons (id, closed_at, snapshot) VALUES (?, ?, ?)')
    .bind(uid(), now, JSON.stringify(snapshot))
    .run();
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export interface RewardRule {
  id: string;
  every_n_visits: number;
  reward_text: string;
}

export async function activeRewardRules(db: D1Database): Promise<RewardRule[]> {
  const r = await db
    .prepare('SELECT id, every_n_visits, reward_text FROM reward_rules WHERE active=1')
    .all<RewardRule>();
  return r.results ?? [];
}

export async function rewardAlreadyAwarded(db: D1Database, phone: string, ruleId: string, threshold: number): Promise<boolean> {
  const r = await db
    .prepare('SELECT COUNT(*) AS c FROM awarded_rewards WHERE member_phone=? AND rule_id=? AND threshold=?')
    .bind(phone, ruleId, threshold)
    .first<{ c: number }>();
  return (r?.c ?? 0) > 0;
}

export async function awardReward(
  db: D1Database,
  a: { phone: string; ruleId: string; threshold: number; text: string },
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO awarded_rewards (id, member_phone, rule_id, threshold, reward_text, awarded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(uid(), a.phone, a.ruleId, a.threshold, a.text, now)
    .run();
}

export interface AwardedRewardRow extends AwardedReward {
  display_name: string | null;
}

export async function listAwardedRewards(db: D1Database): Promise<AwardedRewardRow[]> {
  const r = await db
    .prepare(
      `SELECT a.*, m.display_name FROM awarded_rewards a
       LEFT JOIN members m ON m.phone = a.member_phone
       ORDER BY a.awarded_at DESC`,
    )
    .all<AwardedRewardRow>();
  return r.results ?? [];
}

export async function markRewardRedeemed(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare('UPDATE awarded_rewards SET redeemed_at=? WHERE id=?').bind(now, id).run();
}

// ---------------------------------------------------------------------------
// Public history
// ---------------------------------------------------------------------------

export interface GameResultRow {
  member_phone: string;
  display_name: string | null;
  points: number;
}

/** All scored finishers for one game, highest first (for the public game page). */
export async function gameResults(db: D1Database, gameId: string): Promise<GameResultRow[]> {
  const r = await db
    .prepare(
      `SELECT p.member_phone, m.display_name, p.points
       FROM points_ledger p LEFT JOIN members m ON m.phone = p.member_phone
       WHERE p.game_id = ? ORDER BY p.points DESC`,
    )
    .bind(gameId)
    .all<GameResultRow>();
  return r.results ?? [];
}

export interface RecentResultRow {
  id: string;
  starts_at: string;
  is_tournament: number;
  winner: string | null;
}

/** Recent games that have any results, with the 1st-place name if there is one. */
export async function recentResults(db: D1Database, limit: number): Promise<RecentResultRow[]> {
  const r = await db
    .prepare(
      `SELECT g.id, g.starts_at, g.is_tournament,
              (SELECT m.display_name FROM points_ledger p JOIN members m ON m.phone = p.member_phone
               WHERE p.game_id = g.id AND p.points = 5 LIMIT 1) AS winner
       FROM games g
       WHERE EXISTS (SELECT 1 FROM points_ledger p WHERE p.game_id = g.id)
       ORDER BY g.starts_at DESC LIMIT ?`,
    )
    .bind(limit)
    .all<RecentResultRow>();
  return r.results ?? [];
}

export interface SeasonRow {
  id: string;
  closed_at: string;
  snapshot: { invited?: Array<{ phone: string; name: string | null }>; gameId?: string | null; sent?: number };
}

/** Past seasons (each closed by a Special Players tournament), oldest first. */
export async function listSeasons(db: D1Database): Promise<SeasonRow[]> {
  const r = await db
    .prepare('SELECT id, closed_at, snapshot FROM seasons ORDER BY closed_at ASC')
    .all<{ id: string; closed_at: string; snapshot: string }>();
  return (r.results ?? []).map((row) => {
    let snapshot: SeasonRow['snapshot'] = {};
    try {
      snapshot = JSON.parse(row.snapshot);
    } catch {
      snapshot = {};
    }
    return { id: row.id, closed_at: row.closed_at, snapshot };
  });
}
