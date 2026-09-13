/** Read models for the automatic tournament UI. Mutations live in tournament.ts. */
export type TournamentPlanStatus = 'SCHEDULED' | 'BLOCKED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type TournamentOfferState =
  | 'ACTIVE'
  | 'CONFIRMED'
  | 'DECLINED'
  | 'EXPIRED'
  | 'REPLACED'
  | 'OPTED_OUT'
  | 'CANCELLED';

export interface TournamentPlanRow {
  id: string;
  quarter_key: string;
  game_id: string;
  status: TournamentPlanStatus;
  planned_starts_at: string;
  qualification_cutoff: string;
  confirmation_deadline: string;
  season_id: string | null;
  blocked_reason: string | null;
  tie_score: number | null;
  tie_resolution: string | null;
  version: number;
  schedule_version: number;
  mutation_token: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TournamentBoardRow {
  plan_id: string;
  member_phone: string;
  display_name: string | null;
  rank: number;
  score_rank: number;
  points: number;
  scoring_tiebreak_at: string;
  was_subscribed: number;
  selected_qualifier: number;
}

export interface TournamentOfferRow {
  id: string;
  plan_id: string;
  member_phone: string;
  board_rank: number;
  state: TournamentOfferState;
  offered_at: string;
  response_deadline: string;
  confirmed_at: string | null;
  declined_at: string | null;
  retired_at: string | null;
  replaced_by_offer_id: string | null;
  updated_at: string;
  display_name?: string | null;
}

export interface TournamentPlanView extends TournamentPlanRow {
  game_starts_at: string;
  game_cancelled: number;
  board_count: number;
  active_offers: number;
  confirmed_seats: number;
  exception_count: number;
}

export async function getTournamentPlan(db: D1Database, id: string): Promise<TournamentPlanRow | null> {
  return db.prepare('SELECT * FROM tournament_plans WHERE id=?').bind(id).first<TournamentPlanRow>();
}

export async function listTournamentPlanRows(db: D1Database): Promise<TournamentPlanView[]> {
  const rows = await db
    .prepare(
      `SELECT p.*, g.starts_at AS game_starts_at, g.cancelled AS game_cancelled,
        (SELECT COUNT(*) FROM tournament_board b WHERE b.plan_id=p.id) AS board_count,
        (SELECT COUNT(*) FROM tournament_offers o WHERE o.plan_id=p.id AND o.state='ACTIVE') AS active_offers,
        (SELECT COUNT(*) FROM tournament_offers o WHERE o.plan_id=p.id AND o.state='CONFIRMED') AS confirmed_seats,
        (CASE WHEN p.blocked_reason IS NOT NULL THEN 1 ELSE 0 END) +
        (SELECT COUNT(*) FROM sms_deliveries d WHERE d.plan_id=p.id AND d.state IN ('FAILED','UNKNOWN')) AS exception_count
       FROM tournament_plans p JOIN games g ON g.id=p.game_id
       ORDER BY p.planned_starts_at DESC`,
    )
    .all<TournamentPlanView>();
  return rows.results ?? [];
}

export async function tournamentBoard(db: D1Database, planId: string): Promise<TournamentBoardRow[]> {
  const rows = await db
    .prepare('SELECT * FROM tournament_board WHERE plan_id=? ORDER BY rank ASC')
    .bind(planId)
    .all<TournamentBoardRow>();
  return rows.results ?? [];
}

export async function tournamentOffers(db: D1Database, planId: string): Promise<TournamentOfferRow[]> {
  const rows = await db
    .prepare(
      `SELECT o.*, b.display_name FROM tournament_offers o
       LEFT JOIN tournament_board b ON b.plan_id=o.plan_id AND b.member_phone=o.member_phone
       WHERE o.plan_id=? ORDER BY o.board_rank ASC`,
    )
    .bind(planId)
    .all<TournamentOfferRow>();
  return rows.results ?? [];
}

export async function activeTournamentOfferForPhone(
  db: D1Database,
  phone: string,
): Promise<(TournamentOfferRow & { plan_status: TournamentPlanStatus; starts_at: string; cancelled: number }) | null> {
  return db
    .prepare(
      `SELECT o.*, p.status AS plan_status, g.starts_at, g.cancelled
       FROM tournament_offers o
       JOIN tournament_plans p ON p.id=o.plan_id
       JOIN games g ON g.id=p.game_id
       WHERE o.member_phone=? AND p.status='ACTIVE' AND g.cancelled=0
         AND o.state IN ('ACTIVE','CONFIRMED','DECLINED')
       ORDER BY p.planned_starts_at ASC LIMIT 1`,
    )
    .bind(phone)
    .first<TournamentOfferRow & { plan_status: TournamentPlanStatus; starts_at: string; cancelled: number }>();
}
