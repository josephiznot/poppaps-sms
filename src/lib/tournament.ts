/** Automatic quarterly tournament state machine (ADR-0009). */
import type { Env, Game, StandingRow } from '../types';
import * as coreDb from './db';
import { addDaysToKey, gameLocalDates, localDateInTz, RECURRING, zonedToUtcIso } from './schedule';
import {
  activeTournamentOfferForPhone,
  getTournamentPlan,
  listTournamentPlanRows,
  tournamentBoard,
  tournamentOffers,
  type TournamentBoardRow,
  type TournamentOfferRow,
  type TournamentPlanRow,
  type TournamentPlanView,
} from './tournament-db';
import { listDeliveries, type DeliveryRow } from './delivery';
import {
  automaticTournamentInvite,
  tournamentCancelledMessage,
  tournamentDateChangedMessage,
} from './messages';

const CHICAGO = 'America/Chicago';
const SEATS = 8;
const DAY_MS = 86_400_000;
const uid = () => crypto.randomUUID();
// One-time launch transition requested by the host: close the existing season
// after the September 7 game, then resume the normal quarterly cadence in 2027.
const TRANSITION_DATES: Readonly<Record<string, string>> = {
  '2026-Q4': '2026-09-28',
};

export interface TournamentSummary {
  plan: TournamentPlanView | null;
  board: TournamentBoardRow[];
  offers: TournamentOfferRow[];
  deliveries: DeliveryRow[];
  exceptions: string[];
  asOf: string;
}

export type TournamentResponseOutcome = 'CONFIRMED' | 'DECLINED' | 'EXPIRED' | 'CLOSED';
export interface TournamentResponse {
  handled: boolean;
  outcome?: TournamentResponseOutcome;
  game: Game | null;
}

export interface TournamentTickResult {
  created: number;
  closed: number;
  offersQueued: number;
  completed: number;
}

export const quarterKey = (year: number, quarter: number): string => `${year}-Q${quarter}`;

const quarterParts = (date: Date, timeZone: string): { year: number; quarter: number } => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, quarter: Math.floor((month - 1) / 3) + 1 };
};

const nextQuarter = (year: number, quarter: number): { year: number; quarter: number } =>
  quarter === 4 ? { year: year + 1, quarter: 1 } : { year, quarter: quarter + 1 };

/** First Monday in the quarter that falls on the recurring series' off week. */
export function tournamentOccurrenceForQuarter(year: number, quarter: number, timeZone = CHICAGO): string {
  if (!Number.isInteger(year) || quarter < 1 || quarter > 4) throw new Error('Invalid calendar quarter');
  const transitionDate = TRANSITION_DATES[quarterKey(year, quarter)];
  if (transitionDate) return zonedToUtcIso(`${transitionDate}T${RECURRING.time}`, timeZone);
  const month = (quarter - 1) * 3 + 1;
  let dateKey = `${year}-${String(month).padStart(2, '0')}-01`;
  const anchorMs = new Date(`${RECURRING.anchorDate}T00:00:00Z`).getTime();
  for (let i = 0; i < 14; i++) {
    const current = new Date(`${dateKey}T00:00:00Z`);
    const deltaDays = Math.round((current.getTime() - anchorMs) / DAY_MS);
    const offWeek = ((deltaDays % RECURRING.intervalDays) + RECURRING.intervalDays) % RECURRING.intervalDays === 7;
    if (current.getUTCDay() === 1 && offWeek) return zonedToUtcIso(`${dateKey}T${RECURRING.time}`, timeZone);
    dateKey = addDaysToKey(dateKey, 1);
  }
  throw new Error('No off-week Monday found in quarter');
}

export function tournamentDeadlines(startsAt: string, timeZone = CHICAGO): {
  qualificationCutoff: string;
  confirmationDeadline: string;
} {
  const dateKey = localDateInTz(new Date(startsAt), timeZone);
  return {
    qualificationCutoff: zonedToUtcIso(`${addDaysToKey(dateKey, -14)}T10:00`, timeZone),
    confirmationDeadline: zonedToUtcIso(`${addDaysToKey(dateKey, -7)}T10:00`, timeZone),
  };
}

async function createNextPlan(env: Env, now: Date): Promise<number> {
  const future = await env.DB
    .prepare(
      `SELECT id FROM tournament_plans
       WHERE status IN ('SCHEDULED','BLOCKED','ACTIVE') AND planned_starts_at>?
       ORDER BY planned_starts_at LIMIT 1`,
    )
    .bind(now.toISOString())
    .first<{ id: string }>();
  if (future) return 0;

  let { year, quarter } = quarterParts(now, env.TIMEZONE || CHICAGO);
  for (let attempts = 0; attempts < 12; attempts++) {
    const key = quarterKey(year, quarter);
    const startsAt = tournamentOccurrenceForQuarter(year, quarter, env.TIMEZONE || CHICAGO);
    const deadlines = tournamentDeadlines(startsAt, env.TIMEZONE || CHICAGO);
    const exists = await env.DB.prepare('SELECT id FROM tournament_plans WHERE quarter_key=?').bind(key).first<{ id: string }>();
    if (!exists && deadlines.qualificationCutoff > now.toISOString()) {
      const planId = uid();
      const gameId = uid();
      const dateKey = localDateInTz(new Date(startsAt), env.TIMEZONE || CHICAGO);
      const games = await coreDb.listGames(env.DB);
      const occupied = gameLocalDates(games.filter((g) => g.id !== gameId), env.TIMEZONE || CHICAGO);
      const collision = occupied.has(dateKey);
      const nowIso = now.toISOString();
      try {
        await env.DB.batch([
          env.DB
            .prepare(
              `INSERT INTO games
               (id, starts_at, location, is_tournament, description, buy_in, reminder_sent, cancelled, series_date, created_at)
               VALUES (?, ?, ?, 1, ?, ?, 0, ?, NULL, ?)`,
            )
            .bind(
              gameId,
              startsAt,
              RECURRING.location,
              'Quarterly Special Players tournament',
              RECURRING.buyIn,
              collision ? 1 : 0,
              nowIso,
            ),
          env.DB
            .prepare(
              `INSERT INTO tournament_plans
               (id, quarter_key, game_id, status, planned_starts_at, qualification_cutoff,
                confirmation_deadline, blocked_reason, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              planId,
              key,
              gameId,
              collision ? 'BLOCKED' : 'SCHEDULED',
              startsAt,
              deadlines.qualificationCutoff,
              deadlines.confirmationDeadline,
              collision ? `Tournament date ${dateKey} is occupied; reschedule it before qualification closes.` : null,
              nowIso,
              nowIso,
            ),
        ]);
        return 1;
      } catch (error) {
        // A concurrent tick winning either unique key is an idempotent success.
        const raced = await env.DB.prepare('SELECT id FROM tournament_plans WHERE quarter_key=?').bind(key).first();
        if (raced) return 0;
        throw error;
      }
    }
    ({ year, quarter } = nextQuarter(year, quarter));
  }
  throw new Error('Could not find a future quarterly tournament occurrence');
}

interface FrozenStanding extends StandingRow {
  rank: number;
  scoreRank: number;
  subscribed: boolean;
}

async function qualificationBoard(env: Env, plan: TournamentPlanRow, lowerBound?: string): Promise<FrozenStanding[]> {
  const since = lowerBound ?? await coreDb.lastSeasonClose(env.DB);
  const standings = await coreDb.standings(env.DB, since, plan.qualification_cutoff);
  const members = new Map((await coreDb.listMembers(env.DB)).map((m) => [m.phone, m]));
  let previousScore: number | null = null;
  let scoreRank = 0;
  return standings.map((row, index) => {
    if (row.total !== previousScore) scoreRank = index + 1;
    previousScore = row.total;
    return {
      ...row,
      rank: index + 1,
      scoreRank,
      subscribed: members.get(row.phone)?.status === 'SUBSCRIBED',
    };
  });
}

async function missingResultGames(env: Env, plan: TournamentPlanRow, lowerBound?: string): Promise<Array<{ id: string; starts_at: string }>> {
  const since = lowerBound ?? await coreDb.lastSeasonClose(env.DB);
  const rows = await env.DB
    .prepare(
      `SELECT id, starts_at FROM games
       WHERE cancelled=0 AND is_tournament=0 AND starts_at>? AND starts_at<?
         AND results_recorded_at IS NULL
       ORDER BY starts_at`,
    )
    .bind(since, plan.qualification_cutoff)
    .all<{ id: string; starts_at: string }>();
  return rows.results ?? [];
}

async function setQualificationBlock(
  db: D1Database,
  plan: TournamentPlanRow,
  reason: string,
  tieScore: number | null,
  nowIso: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE tournament_plans SET status='BLOCKED', blocked_reason=?, tie_score=?,
       updated_at=?, version=version+1 WHERE id=? AND season_id IS NULL
       AND (status<>'BLOCKED' OR COALESCE(blocked_reason,'')<>? OR COALESCE(tie_score,-1)<>COALESCE(?,-1))`,
    )
    .bind(reason, tieScore, nowIso, plan.id, reason, tieScore)
    .run();
}

function selectedQualifiers(plan: TournamentPlanRow, board: FrozenStanding[]): FrozenStanding[] | null {
  if (board.length < SEATS) return null;
  const cutoffScore = board[SEATS - 1]!.total;
  const above = board.filter((r) => r.total > cutoffScore);
  const tied = board.filter((r) => r.total === cutoffScore);
  const need = SEATS - above.length;
  if (tied.length <= need) return [...above, ...tied];
  let resolved: string[] = [];
  try {
    resolved = JSON.parse(plan.tie_resolution ?? '[]') as string[];
  } catch {
    return null;
  }
  if (resolved.length !== need || new Set(resolved).size !== need || resolved.some((p) => !tied.some((r) => r.phone === p))) {
    return null;
  }
  return [...above, ...resolved.map((phone) => tied.find((r) => r.phone === phone)!)];
}

async function freezeQualification(env: Env, plan: TournamentPlanRow, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const game = await coreDb.getGame(env.DB, plan.game_id);
  if (!game || game.cancelled) return false;
  if (plan.planned_starts_at <= nowIso || plan.confirmation_deadline <= nowIso) {
    await setQualificationBlock(env.DB, plan, 'The qualification window is overdue; reschedule before closing this season.', null, nowIso);
    return false;
  }
  // Capture every input revision before reading the board. The atomic commit
  // compares these signatures again, so edits anywhere in the read window make
  // this attempt a no-op and the next tick recomputes from one coherent state.
  const seasonLowerBound = await coreDb.lastSeasonClose(env.DB);
  const resultSignature = await env.DB
    .prepare(
      `SELECT COALESCE(group_concat(signature, '|'), '') AS value FROM (
         SELECT id || ':' || result_version AS signature FROM games
         WHERE cancelled=0 AND is_tournament=0 AND starts_at>? AND starts_at<? ORDER BY id
       )`,
    )
    .bind(seasonLowerBound, plan.qualification_cutoff)
    .first<{ value: string }>();
  const memberSignature = await env.DB
    .prepare("SELECT COALESCE(group_concat(signature, '|'), '') AS value FROM (SELECT phone || ':' || status AS signature FROM members ORDER BY phone)")
    .first<{ value: string }>();
  const missing = await missingResultGames(env, plan, seasonLowerBound);
  if (missing.length) {
    await setQualificationBlock(env.DB, plan, `${missing.length} qualifying game${missing.length === 1 ? '' : 's'} need results.`, null, nowIso);
    return false;
  }
  const board = await qualificationBoard(env, plan, seasonLowerBound);
  if (board.length < SEATS) {
    await setQualificationBlock(env.DB, plan, `Only ${board.length} scoring players; eight are required.`, null, nowIso);
    return false;
  }
  const cutoffScore = board[SEATS - 1]!.total;
  const tiedAtCutoff = board.filter((r) => r.total === cutoffScore);
  const selected = selectedQualifiers(plan, board);
  if (!selected) {
    await setQualificationBlock(
      env.DB,
      plan,
      `${tiedAtCutoff.length} players are tied at ${cutoffScore} points across the eighth seat.`,
      cutoffScore,
      nowIso,
    );
    return false;
  }

  const selectedPhones = new Set(selected.map((r) => r.phone));
  const seasonId = uid();
  const nextVersion = plan.version + 1;
  const token = uid();
  const snapshot = {
    planId: plan.id,
    gameId: plan.game_id,
    qualificationCutoff: plan.qualification_cutoff,
    confirmationDeadline: plan.confirmation_deadline,
    tournamentDate: plan.planned_starts_at,
    tieResolution: plan.tie_resolution ? JSON.parse(plan.tie_resolution) : null,
    board: board.map((r) => ({
      phone: r.phone,
      name: r.display_name,
      rank: r.rank,
      scoreRank: r.scoreRank,
      points: r.total,
      scoringTiebreakAt: r.last_award,
      optedOut: !r.subscribed,
      selected: selectedPhones.has(r.phone),
    })),
    invited: selected.map((r) => ({ phone: r.phone, name: r.display_name, optedOut: !r.subscribed })),
  };
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `UPDATE tournament_plans SET status='ACTIVE', season_id=?, closed_at=?, blocked_reason=NULL,
         tie_score=NULL, version=?, mutation_token=?, updated_at=?
         WHERE id=? AND version=? AND season_id IS NULL AND planned_starts_at=? AND qualification_cutoff=?
           AND status IN ('SCHEDULED','BLOCKED')
           AND EXISTS (SELECT 1 FROM games WHERE id=? AND cancelled=0 AND starts_at=?)
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT id || ':' || result_version AS signature FROM games
             WHERE cancelled=0 AND is_tournament=0 AND starts_at>? AND starts_at<? ORDER BY id))
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT phone || ':' || status AS signature FROM members ORDER BY phone))`,
      )
      .bind(
        seasonId, plan.qualification_cutoff, nextVersion, token, nowIso,
        plan.id, plan.version, plan.planned_starts_at, plan.qualification_cutoff,
        plan.game_id, plan.planned_starts_at,
        resultSignature?.value ?? '', seasonLowerBound, plan.qualification_cutoff,
        memberSignature?.value ?? '',
      ),
    env.DB
      .prepare(
        `INSERT INTO seasons (id, closed_at, snapshot)
         SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
      )
      .bind(seasonId, plan.qualification_cutoff, JSON.stringify(snapshot), plan.id, token),
  ];

  for (const row of board) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO tournament_board
           (plan_id, member_phone, display_name, rank, score_rank, points,
            scoring_tiebreak_at, was_subscribed, selected_qualifier)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
        )
        .bind(
          plan.id,
          row.phone,
          row.display_name,
          row.rank,
          row.scoreRank,
          row.total,
          row.last_award,
          row.subscribed ? 1 : 0,
          selectedPhones.has(row.phone) ? 1 : 0,
          plan.id,
          token,
        ),
    );
  }
  for (const row of selected) {
    const offerId = uid();
    const state = row.subscribed ? 'ACTIVE' : 'OPTED_OUT';
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO tournament_offers
           (id, plan_id, member_phone, board_rank, state, offered_at, response_deadline, retired_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
        )
        .bind(
          offerId,
          plan.id,
          row.phone,
          row.rank,
          state,
          nowIso,
          plan.confirmation_deadline,
          row.subscribed ? null : nowIso,
          nowIso,
          plan.id,
          token,
        ),
    );
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO tournament_rsvps (id, season_id, member_phone, invited_at)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
        )
        .bind(uid(), seasonId, row.phone, nowIso, plan.id, token),
    );
    if (row.subscribed) {
      statements.push(
        env.DB
          .prepare(
            `INSERT INTO sms_deliveries
             (id, logical_key, plan_id, game_id, offer_id, recipient, kind, body, version,
              state, expires_at, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, 'TOURNAMENT_INVITE', ?, ?, 'QUEUED', ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
          )
          .bind(
            uid(),
            `tournament:${plan.id}:initial-invite`,
            plan.id,
            plan.game_id,
            offerId,
            row.phone,
            automaticTournamentInvite(env, game, plan.confirmation_deadline),
            plan.schedule_version,
            game.starts_at,
            nowIso,
            nowIso,
            plan.id,
            token,
          ),
      );
    }
  }
  try {
    await env.DB.batch(statements);
    const committed = await getTournamentPlan(env.DB, plan.id);
    return committed?.mutation_token === token && committed.season_id === seasonId;
  } catch (error) {
    const raced = await getTournamentPlan(env.DB, plan.id);
    if (raced?.season_id) return false;
    throw error;
  }
}

const replacementDeadline = (plan: TournamentPlanRow, now: Date): string => {
  const startMs = new Date(plan.planned_starts_at).getTime();
  return new Date(Math.min(now.getTime() + DAY_MS, startMs - DAY_MS)).toISOString();
};

async function refreshAndFillSeats(env: Env, plan: TournamentPlanRow, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const firstPass = await tournamentOffers(env.DB, plan.id);
  const changes: D1PreparedStatement[] = [];
  for (const offer of firstPass) {
    if (offer.state === 'ACTIVE' || offer.state === 'CONFIRMED') {
      const member = await coreDb.getMember(env.DB, offer.member_phone);
      if (member?.status !== 'SUBSCRIBED') {
        changes.push(
          env.DB
            .prepare(
              `UPDATE tournament_offers SET state='OPTED_OUT', retired_at=?, updated_at=?
               WHERE id=? AND state IN ('ACTIVE','CONFIRMED')`,
            )
            .bind(nowIso, nowIso, offer.id),
        );
      } else if (offer.state === 'ACTIVE' && offer.response_deadline <= nowIso) {
        changes.push(
          env.DB
            .prepare("UPDATE tournament_offers SET state='EXPIRED', retired_at=?, updated_at=? WHERE id=? AND state='ACTIVE'")
            .bind(nowIso, nowIso, offer.id),
        );
      }
    }
  }
  if (changes.length) await env.DB.batch(changes);

  const offers = await tournamentOffers(env.DB, plan.id);
  const reserved = offers.filter((o) => o.state === 'ACTIVE' || o.state === 'CONFIRMED').length;
  let available = SEATS - reserved;
  if (available <= 0 || now.getTime() >= new Date(plan.planned_starts_at).getTime() - DAY_MS) return 0;

  const board = await tournamentBoard(env.DB, plan.id);
  const offered = new Set(offers.map((o) => o.member_phone));
  const subscribed = new Set(await coreDb.listSubscribedPhones(env.DB));
  const eligible = board.filter((row) => !offered.has(row.member_phone) && row.was_subscribed === 1 && subscribed.has(row.member_phone));
  if (!eligible.length) return 0;

  const chosen: TournamentBoardRow[] = [];
  let index = 0;
  while (available > 0 && index < eligible.length) {
    const score = eligible[index]!.points;
    const group = eligible.filter((row) => row.points === score);
    if (group.length > available) {
      await env.DB
        .prepare(
          `UPDATE tournament_plans SET blocked_reason=?, tie_score=?, updated_at=?, version=version+1
           WHERE id=? AND status='ACTIVE'
             AND (COALESCE(blocked_reason,'')<>? OR COALESCE(tie_score,-1)<>?)`,
        )
        .bind(
          `${group.length} replacement candidates are tied at ${score} points for ${available} seat${available === 1 ? '' : 's'}.`,
          score, nowIso, plan.id,
          `${group.length} replacement candidates are tied at ${score} points for ${available} seat${available === 1 ? '' : 's'}.`,
          score,
        )
        .run();
      return 0;
    }
    chosen.push(...group);
    available -= group.length;
    index += group.length;
  }
  if (!chosen.length) return 0;

  const game = await coreDb.getGame(env.DB, plan.game_id);
  if (!game) return 0;
  const deadline = replacementDeadline(plan, now);
  const sources = offers
    .filter((o) => !['ACTIVE', 'CONFIRMED'].includes(o.state) && !o.replaced_by_offer_id)
    .sort((a, b) => a.board_rank - b.board_rank);
  const offerSignature = offers.map((o) => `${o.id}:${o.state}:${o.replaced_by_offer_id ?? ''}`).sort().join('|');
  const memberSignature = await env.DB
    .prepare("SELECT COALESCE(group_concat(signature, '|'), '') AS value FROM (SELECT phone || ':' || status AS signature FROM members ORDER BY phone)")
    .first<{ value: string }>();
  const token = uid();
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `UPDATE tournament_plans SET mutation_token=?, blocked_reason=NULL, tie_score=NULL, updated_at=?
         WHERE id=? AND status='ACTIVE' AND version=?
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT id || ':' || state || ':' || COALESCE(replaced_by_offer_id,'') AS signature
             FROM tournament_offers WHERE plan_id=? ORDER BY id))
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT phone || ':' || status AS signature FROM members ORDER BY phone))`,
      )
      .bind(token, nowIso, plan.id, plan.version, offerSignature, plan.id, memberSignature?.value ?? ''),
  ];
  for (let i = 0; i < chosen.length; i++) {
    const row = chosen[i]!;
    const source = sources[i];
    const offerId = uid();
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO tournament_offers
           (id, plan_id, member_phone, board_rank, state, offered_at, response_deadline, updated_at)
           SELECT ?, ?, ?, ?, 'ACTIVE', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)
             AND EXISTS (SELECT 1 FROM members WHERE phone=? AND status='SUBSCRIBED')
             AND (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=? AND state IN ('ACTIVE','CONFIRMED')) < ?`,
        )
        .bind(
          offerId, plan.id, row.member_phone, row.rank, nowIso, deadline, nowIso,
          plan.id, token, row.member_phone, plan.id, SEATS,
        ),
    );
    if (source) {
      statements.push(
        env.DB
          .prepare(
            `UPDATE tournament_offers SET state=CASE WHEN state IN ('DECLINED','EXPIRED','OPTED_OUT') THEN 'REPLACED' ELSE state END,
             replaced_by_offer_id=?, retired_at=COALESCE(retired_at, ?), updated_at=?
             WHERE id=? AND state=? AND replaced_by_offer_id IS NULL
               AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)
               AND EXISTS (SELECT 1 FROM tournament_offers WHERE id=?)`,
          )
          .bind(offerId, nowIso, nowIso, source.id, source.state, plan.id, token, offerId),
      );
    }
    statements.push(
      env.DB
        .prepare('INSERT OR IGNORE INTO tournament_rsvps (id, season_id, member_phone, invited_at) VALUES (?, ?, ?, ?)')
        .bind(uid(), plan.season_id, row.member_phone, nowIso),
      env.DB
        .prepare(
          `INSERT INTO sms_deliveries
           (id, logical_key, plan_id, game_id, offer_id, recipient, kind, body, version,
            state, expires_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 'TOURNAMENT_INVITE', ?, ?, 'QUEUED', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)
             AND EXISTS (SELECT 1 FROM tournament_offers WHERE id=? AND state='ACTIVE')`,
        )
        .bind(
          uid(),
          `tournament:${plan.id}:replacement:${row.member_phone}`,
          plan.id,
          plan.game_id,
          offerId,
          row.member_phone,
          automaticTournamentInvite(env, game, deadline, true),
          plan.schedule_version,
          game.starts_at,
          nowIso,
          plan.id,
          token,
          offerId,
          nowIso,
        ),
    );
  }
  try {
    await env.DB.batch(statements);
    const committed = await getTournamentPlan(env.DB, plan.id);
    return committed?.mutation_token === token ? chosen.length : 0;
  } catch (error) {
    // Unique offer/delivery keys make concurrent fillers converge safely.
    const current = await tournamentOffers(env.DB, plan.id);
    if (chosen.every((row) => current.some((offer) => offer.member_phone === row.member_phone))) return 0;
    throw error;
  }
}

export async function tickTournaments(env: Env, now = new Date()): Promise<TournamentTickResult> {
  const result: TournamentTickResult = { created: await createNextPlan(env, now), closed: 0, offersQueued: 0, completed: 0 };
  const plans = await listTournamentPlanRows(env.DB);
  for (const plan of plans) {
    if (plan.status === 'CANCELLED' || plan.status === 'COMPLETED') continue;
    if (plan.status === 'BLOCKED' && plan.game_cancelled) continue; // occupied default date; host must reschedule
    if (!plan.season_id && plan.qualification_cutoff <= now.toISOString()) {
      if (await freezeQualification(env, plan, now)) result.closed++;
    }
    const current = await getTournamentPlan(env.DB, plan.id);
    if (!current) continue;
    if (current.status === 'ACTIVE') result.offersQueued += await refreshAndFillSeats(env, current, now);
    if (current.status === 'ACTIVE' && current.planned_starts_at <= now.toISOString()) {
      const recorded = await env.DB
        .prepare('SELECT results_recorded_at FROM games WHERE id=?')
        .bind(current.game_id)
        .first<{ results_recorded_at: string | null }>();
      if (recorded?.results_recorded_at) {
        const updated = await env.DB
          .prepare("UPDATE tournament_plans SET status='COMPLETED', version=version+1, updated_at=? WHERE id=? AND status='ACTIVE'")
          .bind(now.toISOString(), current.id)
          .run();
        result.completed += updated.meta.changes ?? 0;
      }
    }
  }
  return result;
}

export async function listTournamentPlans(db: D1Database): Promise<TournamentPlanView[]> {
  return listTournamentPlanRows(db);
}

export async function getTournamentSummary(db: D1Database, now = new Date()): Promise<TournamentSummary> {
  const plans = await listTournamentPlanRows(db);
  const plan = plans.find((p) => p.status !== 'COMPLETED' && p.status !== 'CANCELLED' && p.planned_starts_at >= now.toISOString()) ?? plans[0] ?? null;
  if (!plan) return { plan: null, board: [], offers: [], deliveries: [], exceptions: [], asOf: now.toISOString() };
  const [board, offers, deliveries] = await Promise.all([
    tournamentBoard(db, plan.id),
    tournamentOffers(db, plan.id),
    listDeliveries(db, plan.id),
  ]);
  const exceptions: string[] = [];
  if (plan.blocked_reason) exceptions.push(plan.blocked_reason);
  const failed = deliveries.filter((d) => d.state === 'FAILED').length;
  const unknown = deliveries.filter((d) => d.state === 'UNKNOWN').length;
  if (failed) exceptions.push(`${failed} SMS deliver${failed === 1 ? 'y' : 'ies'} failed.`);
  if (unknown) exceptions.push(`${unknown} SMS outcome${unknown === 1 ? ' is' : 's are'} unknown and will not retry automatically.`);
  return { plan, board, offers, deliveries, exceptions, asOf: now.toISOString() };
}

async function addReplacementOffers(
  env: Env,
  plan: TournamentPlanRow,
  selectedPhones: string[],
  now: Date,
  expectedVersion: number,
): Promise<void> {
  const board = await tournamentBoard(env.DB, plan.id);
  const offers = await tournamentOffers(env.DB, plan.id);
  const reserved = offers.filter((o) => o.state === 'ACTIVE' || o.state === 'CONFIRMED').length;
  const available = SEATS - reserved;
  if (selectedPhones.length !== available || new Set(selectedPhones).size !== selectedPhones.length) {
    throw new Error(`Select exactly ${available} tied replacement candidate${available === 1 ? '' : 's'}.`);
  }
  const tied = board.filter((b) => b.points === plan.tie_score && !offers.some((o) => o.member_phone === b.member_phone));
  if (selectedPhones.some((phone) => !tied.some((b) => b.member_phone === phone))) throw new Error('Selection must come from the blocked tie group.');
  const subscribed = new Set(await coreDb.listSubscribedPhones(env.DB));
  if (selectedPhones.some((phone) => !subscribed.has(phone))) throw new Error('A selected replacement is no longer subscribed.');
  const game = await coreDb.getGame(env.DB, plan.game_id);
  if (!game) throw new Error('Tournament game not found.');
  const deadline = replacementDeadline(plan, now);
  if (deadline <= now.toISOString()) throw new Error('No new invitation can be sent inside 24 hours of play.');
  const nowIso = now.toISOString();
  const token = uid();
  const nextVersion = expectedVersion + 1;
  const sources = offers.filter((o) => !['ACTIVE', 'CONFIRMED'].includes(o.state) && !o.replaced_by_offer_id);
  const offerSignature = offers.map((o) => `${o.id}:${o.state}:${o.replaced_by_offer_id ?? ''}`).sort().join('|');
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `UPDATE tournament_plans SET version=?, mutation_token=?, blocked_reason=NULL, tie_score=NULL, updated_at=?
         WHERE id=? AND version=? AND status='ACTIVE'
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT id || ':' || state || ':' || COALESCE(replaced_by_offer_id,'') AS signature
             FROM tournament_offers WHERE plan_id=? ORDER BY id))`,
      )
      .bind(nextVersion, token, nowIso, plan.id, expectedVersion, offerSignature, plan.id),
  ];
  for (let i = 0; i < selectedPhones.length; i++) {
    const phone = selectedPhones[i]!;
    const row = board.find((b) => b.member_phone === phone)!;
    const offerId = uid();
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO tournament_offers
           (id, plan_id, member_phone, board_rank, state, offered_at, response_deadline, updated_at)
           SELECT ?, ?, ?, ?, 'ACTIVE', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)
             AND EXISTS (SELECT 1 FROM members WHERE phone=? AND status='SUBSCRIBED')
             AND (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=? AND state IN ('ACTIVE','CONFIRMED')) < ?`,
        )
        .bind(offerId, plan.id, phone, row.rank, nowIso, deadline, nowIso, plan.id, token, phone, plan.id, SEATS),
    );
    const source = sources[i];
    if (source) statements.push(
      env.DB
        .prepare(
          `UPDATE tournament_offers SET state='REPLACED', replaced_by_offer_id=?, retired_at=COALESCE(retired_at,?), updated_at=?
           WHERE id=? AND state=? AND replaced_by_offer_id IS NULL
             AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)
             AND EXISTS (SELECT 1 FROM tournament_offers WHERE id=?)`,
        )
        .bind(offerId, nowIso, nowIso, source.id, source.state, plan.id, token, offerId),
    );
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO tournament_rsvps (id, season_id, member_phone, invited_at)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tournament_offers WHERE id=? AND state='ACTIVE')`,
        )
        .bind(uid(), plan.season_id, phone, nowIso, offerId),
      env.DB
        .prepare(
          `INSERT INTO sms_deliveries
           (id, logical_key, plan_id, game_id, offer_id, recipient, kind, body, version, state, expires_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 'TOURNAMENT_INVITE', ?, ?, 'QUEUED', ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)
             AND EXISTS (SELECT 1 FROM tournament_offers WHERE id=? AND state='ACTIVE')`,
        )
        .bind(
          uid(), `tournament:${plan.id}:replacement:${phone}`, plan.id, plan.game_id, offerId, phone,
          automaticTournamentInvite(env, game, deadline, true), plan.schedule_version, game.starts_at, nowIso, nowIso,
          plan.id, token, offerId,
        ),
    );
  }
  await env.DB.batch(statements);
  const updated = await getTournamentPlan(env.DB, plan.id);
  if (updated?.mutation_token !== token) throw new Error('Tournament changed while resolving the tie. Refresh and try again.');
}

export async function resolveTournamentTie(
  env: Env,
  planId: string,
  phones: string[],
  now = new Date(),
  expectedVersion?: number,
): Promise<TournamentSummary> {
  const plan = await getTournamentPlan(env.DB, planId);
  if (!plan) throw new Error('Tournament plan not found.');
  const expected = expectedVersion ?? plan.version;
  if (plan.version !== expected) throw new Error('Tournament changed; refresh before resolving the tie.');
  if (plan.tie_score == null || !plan.blocked_reason) throw new Error('This tournament has no unresolved cutoff tie.');

  if (!plan.season_id) {
    const board = await qualificationBoard(env, plan);
    const tied = board.filter((row) => row.total === plan.tie_score);
    const above = board.filter((row) => row.total > plan.tie_score!);
    const need = SEATS - above.length;
    if (phones.length !== need || new Set(phones).size !== need || phones.some((p) => !tied.some((r) => r.phone === p))) {
      throw new Error(`Select exactly ${need} players from the ${plan.tie_score}-point cutoff tie.`);
    }
    const token = uid();
    const mutation = await env.DB
      .prepare(
        `UPDATE tournament_plans SET tie_resolution=?, status='SCHEDULED', blocked_reason=NULL,
         version=version+1, mutation_token=?, updated_at=? WHERE id=? AND version=? AND season_id IS NULL`,
      )
      .bind(JSON.stringify(phones), token, now.toISOString(), plan.id, expected)
      .run();
    if ((mutation.meta.changes ?? 0) !== 1) throw new Error('Tournament changed while resolving the tie. Refresh and try again.');
    await tickTournaments(env, now);
  } else {
    await addReplacementOffers(env, plan, phones, now, expected);
  }
  return getTournamentSummary(env.DB, now);
}

export async function rescheduleTournament(
  env: Env,
  planId: string,
  date: string,
  now = new Date(),
  expectedVersion?: number,
): Promise<TournamentSummary> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Tournament date must be YYYY-MM-DD.');
  const plan = await getTournamentPlan(env.DB, planId);
  if (!plan) throw new Error('Tournament plan not found.');
  const expected = expectedVersion ?? plan.version;
  if (plan.version !== expected) throw new Error('Tournament changed; refresh before rescheduling.');
  if (plan.status === 'CANCELLED' || plan.status === 'COMPLETED') throw new Error('A completed or cancelled tournament cannot be rescheduled.');
  const startsAt = zonedToUtcIso(`${date}T${RECURRING.time}`, env.TIMEZONE || CHICAGO);
  if (localDateInTz(new Date(startsAt), env.TIMEZONE || CHICAGO) !== date) throw new Error('Tournament date is not a valid calendar day.');
  if (startsAt <= now.toISOString()) throw new Error('Tournament date must be in the future.');
  const dateMs = new Date(`${date}T00:00:00Z`).getTime();
  const anchorMs = new Date(`${RECURRING.anchorDate}T00:00:00Z`).getTime();
  const cadenceOffset = ((Math.round((dateMs - anchorMs) / DAY_MS) % RECURRING.intervalDays) + RECURRING.intervalDays) % RECURRING.intervalDays;
  if (cadenceOffset === 0) throw new Error('That date is a regular-game night; choose an off week.');
  const games = await coreDb.listGames(env.DB);
  const occupied = games.some(
    (game) => game.id !== plan.game_id && !game.cancelled && localDateInTz(new Date(game.starts_at), env.TIMEZONE || CHICAGO) === date,
  );
  if (occupied) throw new Error('That date already has a scheduled game.');
  const deadlines = tournamentDeadlines(startsAt, env.TIMEZONE || CHICAGO);
  if (!plan.season_id && deadlines.qualificationCutoff <= now.toISOString()) {
    throw new Error('A tournament that has not qualified needs at least fourteen days notice.');
  }
  if (plan.season_id && deadlines.confirmationDeadline <= now.toISOString()) {
    throw new Error('An active tournament must be rescheduled with at least seven days for current invitees to respond.');
  }
  const nowIso = now.toISOString();
  const token = uid();
  const nextVersion = expected + 1;
  const nextScheduleVersion = plan.schedule_version + 1;
  const updatedGame = { ...(await coreDb.getGame(env.DB, plan.game_id))!, starts_at: startsAt, cancelled: 0 } as Game;
  const offers = plan.season_id ? await tournamentOffers(env.DB, plan.id) : [];
  const priorDeliveries = plan.season_id ? await listDeliveries(env.DB, plan.id) : [];
  const recipients = [...new Set(offers.filter((o) => o.state === 'ACTIVE' || o.state === 'CONFIRMED').map((o) => o.member_phone))];
  const subscribed = new Set(await coreDb.listSubscribedPhones(env.DB));
  const offerSignature = offers.map((o) => `${o.id}:${o.state}:${o.replaced_by_offer_id ?? ''}`).sort().join('|');
  const qualificationCutoff = plan.season_id ? plan.qualification_cutoff : deadlines.qualificationCutoff;
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `UPDATE tournament_plans SET planned_starts_at=?, qualification_cutoff=?, confirmation_deadline=?,
         status=CASE WHEN status='BLOCKED' AND season_id IS NULL THEN 'SCHEDULED' ELSE status END,
         blocked_reason=NULL, tie_score=NULL, version=?, schedule_version=?, mutation_token=?, updated_at=?
         WHERE id=? AND version=?
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT id || ':' || state || ':' || COALESCE(replaced_by_offer_id,'') AS signature
             FROM tournament_offers WHERE plan_id=? ORDER BY id))`,
      )
      .bind(
        startsAt, qualificationCutoff, deadlines.confirmationDeadline,
        nextVersion, nextScheduleVersion, token, nowIso, plan.id, expected, offerSignature, plan.id,
      ),
    env.DB
      .prepare(
        `UPDATE games SET starts_at=?, cancelled=0, reminder_sent=0
         WHERE id=? AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
      )
      .bind(startsAt, plan.game_id, plan.id, token),
    env.DB
      .prepare(
        `UPDATE sms_deliveries SET state='SUPPRESSED', retryable=0, updated_at=?, last_error='Tournament date changed'
         WHERE plan_id=? AND state IN ('QUEUED','FAILED') AND version<?
           AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
      )
      .bind(nowIso, plan.id, nextScheduleVersion, plan.id, token),
  ];
  if (plan.season_id) {
    const activeDeadline = new Date(Math.min(
      new Date(deadlines.confirmationDeadline).getTime(),
      new Date(startsAt).getTime() - DAY_MS,
    )).toISOString();
    statements.push(
      env.DB
        .prepare(
          `UPDATE tournament_offers SET response_deadline=?, updated_at=?
           WHERE plan_id=? AND state='ACTIVE'
             AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
        )
        .bind(activeDeadline, nowIso, plan.id, plan.id, token),
    );
    for (const phone of recipients.filter((p) => subscribed.has(p))) {
      const offer = offers.find((o) => o.member_phone === phone)!;
      const notified = priorDeliveries.some(
        (d) => d.offer_id === offer.id && d.kind === 'TOURNAMENT_INVITE' && ['SENDING', 'ACCEPTED', 'DELIVERED', 'UNKNOWN'].includes(d.state),
      );
      const kind = notified ? 'TOURNAMENT_DATE_CHANGE' : 'TOURNAMENT_INVITE';
      const body = notified
        ? tournamentDateChangedMessage(env, updatedGame, offer.state === 'ACTIVE' ? activeDeadline : undefined)
        : automaticTournamentInvite(env, updatedGame, activeDeadline, offer.board_rank > SEATS);
      statements.push(
        env.DB
          .prepare(
            `INSERT OR IGNORE INTO sms_deliveries
             (id, logical_key, plan_id, game_id, offer_id, recipient, kind, body, version, state, expires_at, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?
             WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
          )
          .bind(
            uid(), `tournament:${plan.id}:${notified ? 'date-change' : 'invite'}:v${nextScheduleVersion}`, plan.id, plan.game_id, offer.id,
            phone, kind, body, nextScheduleVersion, startsAt, nowIso, nowIso,
            plan.id, token,
          ),
      );
    }
  }
  await env.DB.batch(statements);
  const updated = await getTournamentPlan(env.DB, plan.id);
  if (updated?.mutation_token !== token) throw new Error('Tournament changed while rescheduling. Refresh and try again.');
  return getTournamentSummary(env.DB, now);
}

export async function cancelTournament(
  env: Env,
  planId: string,
  now = new Date(),
  expectedVersion?: number,
): Promise<TournamentSummary> {
  const plan = await getTournamentPlan(env.DB, planId);
  if (!plan) throw new Error('Tournament plan not found.');
  const expected = expectedVersion ?? plan.version;
  if (plan.version !== expected) throw new Error('Tournament changed; refresh before cancelling.');
  if (plan.status === 'COMPLETED') throw new Error('A completed tournament cannot be cancelled.');
  if (plan.status === 'CANCELLED') return getTournamentSummary(env.DB, now);
  const nowIso = now.toISOString();
  const token = uid();
  const nextScheduleVersion = plan.schedule_version + 1;
  const offers = await tournamentOffers(env.DB, plan.id);
  const priorDeliveries = await listDeliveries(env.DB, plan.id);
  const recipients = [...new Set(
    offers
      .filter((o) => o.state === 'ACTIVE' || o.state === 'CONFIRMED')
      .filter((o) => priorDeliveries.some(
        (d) => d.offer_id === o.id && d.kind === 'TOURNAMENT_INVITE' && ['SENDING', 'ACCEPTED', 'DELIVERED', 'UNKNOWN'].includes(d.state),
      ))
      .map((o) => o.member_phone),
  )];
  const subscribed = new Set(await coreDb.listSubscribedPhones(env.DB));
  const offerSignature = offers.map((o) => `${o.id}:${o.state}:${o.replaced_by_offer_id ?? ''}`).sort().join('|');
  const statements: D1PreparedStatement[] = [
    env.DB
      .prepare(
        `UPDATE tournament_plans SET status='CANCELLED', cancelled_at=?, blocked_reason=NULL,
         version=version+1, schedule_version=?, mutation_token=?, updated_at=? WHERE id=? AND version=?
           AND ?=(SELECT COALESCE(group_concat(signature, '|'), '') FROM (
             SELECT id || ':' || state || ':' || COALESCE(replaced_by_offer_id,'') AS signature
             FROM tournament_offers WHERE plan_id=? ORDER BY id))`,
      )
      .bind(nowIso, nextScheduleVersion, token, nowIso, plan.id, expected, offerSignature, plan.id),
    env.DB
      .prepare(
        `UPDATE games SET cancelled=1 WHERE id=?
         AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
      )
      .bind(plan.game_id, plan.id, token),
    env.DB
      .prepare(
        `UPDATE tournament_offers SET state='CANCELLED', retired_at=COALESCE(retired_at,?), updated_at=?
         WHERE plan_id=? AND state IN ('ACTIVE','CONFIRMED')
           AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
      )
      .bind(nowIso, nowIso, plan.id, plan.id, token),
    env.DB
      .prepare(
        `UPDATE sms_deliveries SET state='SUPPRESSED', retryable=0, updated_at=?, last_error='Tournament cancelled'
         WHERE plan_id=? AND state IN ('QUEUED','FAILED')
           AND EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
      )
      .bind(nowIso, plan.id, plan.id, token),
  ];
  for (const phone of recipients.filter((p) => subscribed.has(p))) {
    const offer = offers.find((o) => o.member_phone === phone)!;
    statements.push(
      env.DB
        .prepare(
          `INSERT OR IGNORE INTO sms_deliveries
           (id, logical_key, plan_id, game_id, offer_id, recipient, kind, body, version, state, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 'TOURNAMENT_CANCELLED', ?, ?, 'QUEUED', ?, ?
           WHERE EXISTS (SELECT 1 FROM tournament_plans WHERE id=? AND mutation_token=?)`,
        )
        .bind(
          uid(), `tournament:${plan.id}:cancelled`, plan.id, plan.game_id, offer.id, phone,
          tournamentCancelledMessage(env), nextScheduleVersion, nowIso, nowIso, plan.id, token,
        ),
    );
  }
  await env.DB.batch(statements);
  const updated = await getTournamentPlan(env.DB, plan.id);
  if (updated?.mutation_token !== token) throw new Error('Tournament changed while cancelling. Refresh and try again.');
  return getTournamentSummary(env.DB, now);
}

/** CALL/FOLD against the current durable offer. Automatic plans take priority
 * over legacy season RSVPs. */
export async function respondToTournamentOffer(
  env: Env,
  phone: string,
  action: 'CONFIRM' | 'DECLINE',
  now = new Date(),
): Promise<TournamentResponse> {
  const member = await coreDb.getMember(env.DB, phone);
  if (member?.status !== 'SUBSCRIBED') return { handled: false, game: null };
  const offer = await activeTournamentOfferForPhone(env.DB, phone);
  if (!offer) {
    const historic = await env.DB
      .prepare(
        `SELECT o.id, p.status, g.starts_at, g.cancelled FROM tournament_offers o
         JOIN tournament_plans p ON p.id=o.plan_id JOIN games g ON g.id=p.game_id
         WHERE o.member_phone=? ORDER BY p.planned_starts_at DESC LIMIT 1`,
      )
      .bind(phone)
      .first<{ id: string; status: string; starts_at: string; cancelled: number }>();
    return historic ? { handled: true, outcome: 'CLOSED', game: null } : { handled: false, game: null };
  }
  const game = await coreDb.getGame(env.DB, offer.plan_id ? (await getTournamentPlan(env.DB, offer.plan_id))!.game_id : '');
  const nowIso = now.toISOString();
  if (offer.cancelled || offer.starts_at <= nowIso || offer.plan_status !== 'ACTIVE') {
    return { handled: true, outcome: 'CLOSED', game };
  }

  if (action === 'DECLINE') {
    if (offer.replaced_by_offer_id) return { handled: true, outcome: 'EXPIRED', game };
    await env.DB
      .prepare(
        `UPDATE tournament_offers SET state='DECLINED', declined_at=COALESCE(declined_at,?),
         confirmed_at=NULL, retired_at=?, updated_at=?
         WHERE id=? AND replaced_by_offer_id IS NULL AND state IN ('ACTIVE','CONFIRMED','DECLINED')`,
      )
      .bind(nowIso, nowIso, nowIso, offer.id)
      .run();
    await tickTournaments(env, now);
    return { handled: true, outcome: 'DECLINED', game };
  }

  if (offer.response_deadline <= nowIso || offer.replaced_by_offer_id || !['ACTIVE', 'CONFIRMED', 'DECLINED'].includes(offer.state)) {
    return { handled: true, outcome: 'EXPIRED', game };
  }
  const updated = await env.DB
    .prepare(
      `UPDATE tournament_offers SET state='CONFIRMED', confirmed_at=COALESCE(confirmed_at,?),
       declined_at=NULL, retired_at=NULL, updated_at=?
       WHERE id=? AND replaced_by_offer_id IS NULL
         AND state IN ('ACTIVE','CONFIRMED','DECLINED')
         AND (state IN ('ACTIVE','CONFIRMED') OR
           (state='DECLINED' AND
            (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=? AND state IN ('ACTIVE','CONFIRMED')) < ?))`,
    )
    .bind(nowIso, nowIso, offer.id, offer.plan_id, SEATS)
    .run();
  if ((updated.meta.changes ?? 0) !== 1) return { handled: true, outcome: 'EXPIRED', game };
  return { handled: true, outcome: 'CONFIRMED', game };
}
