/** Durable, per-recipient SMS outbox for automated work (ADR-0009). */
import type { Env } from '../types';
import { getSmsStatus, sendSmsDetailed, TwilioSendError, type TwilioSendResult } from './twilio';

export type DeliveryKind =
  | 'REGULAR_REMINDER'
  | 'TOURNAMENT_INVITE'
  | 'TOURNAMENT_REMINDER'
  | 'TOURNAMENT_DATE_CHANGE'
  | 'TOURNAMENT_CANCELLED'
  | 'PROMO';

export type DeliveryState =
  | 'QUEUED'
  | 'SENDING'
  | 'ACCEPTED'
  | 'DELIVERED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'SUPPRESSED';

export interface DeliveryRow {
  id: string;
  logical_key: string;
  plan_id: string | null;
  game_id: string | null;
  offer_id: string | null;
  recipient: string;
  kind: DeliveryKind;
  body: string;
  version: number;
  state: DeliveryState;
  provider_sid: string | null;
  provider_status: string | null;
  provider_status_rank: number;
  retryable: number;
  attempt_count: number;
  claim_token: string | null;
  claimed_at: string | null;
  attempted_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QueueDeliveryInput {
  logicalKey: string;
  recipient: string;
  kind: DeliveryKind;
  body: string;
  now: string;
  planId?: string | null;
  gameId?: string | null;
  offerId?: string | null;
  version?: number;
  expiresAt?: string | null;
}

const uid = () => crypto.randomUUID();

/** Queue a logical message exactly once for one recipient. */
export async function queueDelivery(db: D1Database, input: QueueDeliveryInput): Promise<string> {
  const id = uid();
  await db
    .prepare(
      `INSERT OR IGNORE INTO sms_deliveries
       (id, logical_key, plan_id, game_id, offer_id, recipient, kind, body, version,
        state, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
    )
    .bind(
      id,
      input.logicalKey,
      input.planId ?? null,
      input.gameId ?? null,
      input.offerId ?? null,
      input.recipient,
      input.kind,
      input.body,
      input.version ?? 1,
      input.expiresAt ?? null,
      input.now,
      input.now,
    )
    .run();
  const row = await db
    .prepare('SELECT id FROM sms_deliveries WHERE logical_key=? AND recipient=?')
    .bind(input.logicalKey, input.recipient)
    .first<{ id: string }>();
  if (!row) throw new Error('Delivery was not queued');
  return row.id;
}

export async function listDeliveries(db: D1Database, planId?: string): Promise<DeliveryRow[]> {
  const statement = planId
    ? db.prepare('SELECT * FROM sms_deliveries WHERE plan_id=? ORDER BY created_at DESC').bind(planId)
    : db.prepare('SELECT * FROM sms_deliveries ORDER BY created_at DESC LIMIT 250');
  const rows = await statement.all<DeliveryRow>();
  return rows.results ?? [];
}

async function getDelivery(db: D1Database, id: string): Promise<DeliveryRow | null> {
  return db.prepare('SELECT * FROM sms_deliveries WHERE id=?').bind(id).first<DeliveryRow>();
}

/** A crashed Worker may leave a row in SENDING. Its provider outcome is
 * ambiguous, so quarantine it as UNKNOWN rather than automatically duplicating. */
export async function quarantineAbandonedClaims(db: D1Database, now: Date, staleMinutes = 5): Promise<number> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000).toISOString();
  const result = await db
    .prepare(
      `UPDATE sms_deliveries
       SET state='UNKNOWN', retryable=0, claim_token=NULL, updated_at=?,
           last_error='Worker ended while provider request was in progress'
       WHERE state='SENDING' AND claimed_at < ?`,
    )
    .bind(now.toISOString(), cutoff)
    .run();
  return result.meta.changes ?? 0;
}

export async function suppressExpiredDeliveries(db: D1Database, now: Date): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE sms_deliveries SET state='SUPPRESSED', retryable=0,
       last_error='Message expired before dispatch', updated_at=?
       WHERE state IN ('QUEUED','FAILED') AND expires_at IS NOT NULL AND expires_at<=?`,
    )
    .bind(nowIso, nowIso)
    .run();
  return result.meta.changes ?? 0;
}

async function claimNext(db: D1Database, now: Date, tickStartedIso: string): Promise<DeliveryRow | null> {
  const token = uid();
  const nowIso = now.toISOString();
  await db
    .prepare(
      `UPDATE sms_deliveries
       SET state='SENDING', claim_token=?, claimed_at=?, attempted_at=?,
           attempt_count=attempt_count+1, updated_at=?
       WHERE id = (
         SELECT id FROM sms_deliveries
         WHERE (state='QUEUED' OR (state='FAILED' AND retryable=1 AND attempt_count < 3))
           AND (expires_at IS NULL OR expires_at > ?)
           AND (attempted_at IS NULL OR attempted_at < ?)
         ORDER BY created_at ASC LIMIT 1
       )
       AND (state='QUEUED' OR (state='FAILED' AND retryable=1 AND attempt_count < 3))`,
    )
    .bind(token, nowIso, nowIso, nowIso, nowIso, tickStartedIso)
    .run();
  return db.prepare('SELECT * FROM sms_deliveries WHERE claim_token=?').bind(token).first<DeliveryRow>();
}

/** Check business intent immediately before transport. */
export async function deliveryIsStillValid(db: D1Database, d: DeliveryRow, nowIso: string): Promise<boolean> {
  const member = await db
    .prepare("SELECT status FROM members WHERE phone=? AND status='SUBSCRIBED'")
    .bind(d.recipient)
    .first<{ status: string }>();
  if (!member) return false;

  if (d.expires_at && d.expires_at <= nowIso) return false;
  if (d.kind === 'PROMO') return true;

  if (d.kind === 'REGULAR_REMINDER') {
    const game = await db
      .prepare('SELECT id FROM games WHERE id=? AND is_tournament=0 AND cancelled=0 AND starts_at>?')
      .bind(d.game_id, nowIso)
      .first<{ id: string }>();
    return !!game;
  }

  const plan = await db
    .prepare(
      `SELECT p.status, p.schedule_version, g.cancelled, g.starts_at
       FROM tournament_plans p JOIN games g ON g.id=p.game_id WHERE p.id=?`,
    )
    .bind(d.plan_id)
    .first<{ status: string; schedule_version: number; cancelled: number; starts_at: string }>();
  if (!plan || plan.schedule_version !== d.version) return false;
  if (d.kind === 'TOURNAMENT_CANCELLED') return plan.status === 'CANCELLED';
  if (plan.status !== 'ACTIVE' || plan.cancelled || plan.starts_at <= nowIso) return false;

  const offer = await db
    .prepare("SELECT state FROM tournament_offers WHERE id=? AND plan_id=? AND member_phone=?")
    .bind(d.offer_id, d.plan_id, d.recipient)
    .first<{ state: string }>();
  return !!offer && (offer.state === 'ACTIVE' || offer.state === 'CONFIRMED');
}

export interface DrainOptions {
  limit?: number;
  paceMs?: number;
  transport?: (env: Env, to: string, body: string, deliveryId?: string) => Promise<TwilioSendResult>;
  clock?: () => Date;
}

export interface DrainResult {
  accepted: number;
  failed: number;
  unknown: number;
  suppressed: number;
}

/** Drain claimed rows sequentially. A definite retryable provider error may be
 * retried on a later cron tick; an ambiguous network outcome is UNKNOWN. */
export async function drainOutbox(env: Env, now = new Date(), options: DrainOptions = {}): Promise<DrainResult> {
  await quarantineAbandonedClaims(env.DB, now);
  await suppressExpiredDeliveries(env.DB, now);
  const result: DrainResult = { accepted: 0, failed: 0, unknown: 0, suppressed: 0 };
  const limit = Math.max(0, Math.min(options.limit ?? 20, 100));
  const paceMs = Math.max(0, options.paceMs ?? 1000);
  const transport = options.transport ?? ((e: Env, to: string, body: string, id?: string) => sendSmsDetailed(e, to, body, fetch, id));
  const clock = options.clock ?? (() => new Date());
  const tickStartedIso = now.toISOString();

  for (let i = 0; i < limit; i++) {
    const currentNow = options.clock ? clock() : (i === 0 ? now : clock());
    const delivery = await claimNext(env.DB, currentNow, tickStartedIso);
    if (!delivery) break;

    if (!(await deliveryIsStillValid(env.DB, delivery, currentNow.toISOString()))) {
      await env.DB
        .prepare(
          `UPDATE sms_deliveries SET state='SUPPRESSED', retryable=0, claim_token=NULL,
           last_error='Recipient or event no longer eligible', updated_at=? WHERE id=? AND state='SENDING'`,
        )
        .bind(currentNow.toISOString(), delivery.id)
        .run();
      result.suppressed++;
      continue;
    }

    try {
      const sent = await transport(env, delivery.recipient, delivery.body, delivery.id);
      const finishedAt = clock().toISOString();
      await env.DB
        .prepare(
          `UPDATE sms_deliveries SET state='ACCEPTED', provider_sid=?, provider_status=?,
           provider_status_rank=10, accepted_at=?, retryable=0, claim_token=NULL,
           last_error_code=NULL, last_error=NULL, updated_at=?
           WHERE id=? AND state='SENDING' AND provider_status_rank < 10`,
        )
        .bind(sent.sid, sent.status, finishedAt, finishedAt, delivery.id)
        .run();
      result.accepted++;
    } catch (error) {
      if (error instanceof TwilioSendError) {
        const finishedAt = clock().toISOString();
        await env.DB
          .prepare(
            `UPDATE sms_deliveries SET state='FAILED', retryable=?, failed_at=?, claim_token=NULL,
             last_error_code=?, last_error=?, updated_at=? WHERE id=? AND state='SENDING'`,
          )
          .bind(error.retryable ? 1 : 0, finishedAt, error.code, error.message.slice(0, 500), finishedAt, delivery.id)
          .run();
        result.failed++;
      } else {
        const finishedAt = clock().toISOString();
        await env.DB
          .prepare(
            `UPDATE sms_deliveries SET state='UNKNOWN', retryable=0, claim_token=NULL,
             last_error=?, updated_at=? WHERE id=? AND state='SENDING'`,
          )
          .bind(String(error).slice(0, 500), finishedAt, delivery.id)
          .run();
        result.unknown++;
      }
    }

    if (paceMs && i + 1 < limit) await new Promise((resolve) => setTimeout(resolve, paceMs));
  }
  return result;
}

/** Explicit safe retry: only definite retryable provider failures qualify. */
export async function retryDelivery(env: Env, id: string, now = new Date()): Promise<boolean> {
  const result = await env.DB
    .prepare(
      `UPDATE sms_deliveries SET state='QUEUED', retryable=0, claim_token=NULL,
       updated_at=? WHERE id=? AND state='FAILED' AND retryable=1`,
    )
    .bind(now.toISOString(), id)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Recover tournament invitations that Twilio definitively rejected because its
 * own opt-out state had not yet been cleared. An authoritative inbound START is
 * the evidence that the provider block is gone; all business intent is checked
 * again here before returning the existing logical message to the outbox.
 */
export async function requeueProviderOptOutTournamentInvites(
  db: D1Database,
  recipient: string,
  now = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE sms_deliveries
       SET state='QUEUED', retryable=0, provider_status=NULL, provider_status_rank=0,
           claim_token=NULL, claimed_at=NULL, last_error_code=NULL, last_error=NULL,
           updated_at=?
       WHERE recipient=?
         AND kind='TOURNAMENT_INVITE'
         AND state='FAILED'
         AND last_error_code='21610'
         AND provider_sid IS NULL
         AND (expires_at IS NULL OR expires_at>?)
         AND EXISTS (
           SELECT 1
           FROM tournament_offers o
           JOIN tournament_plans p ON p.id=o.plan_id
           JOIN games g ON g.id=p.game_id
           WHERE o.id=sms_deliveries.offer_id
             AND o.plan_id=sms_deliveries.plan_id
             AND o.member_phone=sms_deliveries.recipient
             AND o.state='ACTIVE'
             AND o.response_deadline>?
             AND p.status='ACTIVE'
             AND g.id=sms_deliveries.game_id
             AND g.cancelled=0
             AND g.starts_at>?
         )`,
    )
    .bind(nowIso, recipient, nowIso, nowIso, nowIso)
    .run();
  return result.meta.changes ?? 0;
}

const providerRank = (status: string): number => {
  switch (status.toLowerCase()) {
    case 'accepted': return 10;
    case 'queued': return 20;
    case 'sending': return 30;
    case 'sent': return 40;
    case 'delivered': return 100;
    case 'undelivered':
    case 'failed': return 100;
    case 'canceled': return 100;
    default: return 0;
  }
};

/** Apply a signed Twilio callback without allowing stale callbacks to regress a
 * final or later transport state. */
export async function updateDeliveryStatus(
  env: Env,
  sid: string,
  status: string,
  errorCode: string | null = null,
  now = new Date(),
  deliveryId: string | null = null,
): Promise<boolean> {
  const rank = providerRank(status);
  if (!sid || rank === 0) return false;
  const normalized = status.toLowerCase();
  const state: DeliveryState = normalized === 'delivered'
    ? 'DELIVERED'
    : ['undelivered', 'failed', 'canceled'].includes(normalized)
      ? 'FAILED'
      : 'ACCEPTED';
  const result = await env.DB
    .prepare(
      `UPDATE sms_deliveries
       SET state=?, provider_sid=COALESCE(provider_sid, ?), provider_status=?, provider_status_rank=?, last_error_code=?,
           delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE delivered_at END,
           failed_at=CASE WHEN ?='FAILED' THEN ? ELSE failed_at END,
           retryable=0, updated_at=?
       WHERE (provider_sid=? OR (? IS NOT NULL AND id=? AND (provider_sid IS NULL OR provider_sid=?)))
         AND provider_status_rank < ?`,
    )
    .bind(
      state, sid, normalized, rank, errorCode,
      state, now.toISOString(), state, now.toISOString(), now.toISOString(),
      sid, deliveryId, deliveryId, sid, rank,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Read-only provider reconciliation for rows with a known SID. */
export async function reconcileDelivery(
  env: Env,
  id: string,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<DeliveryRow | null> {
  const row = await getDelivery(env.DB, id);
  if (!row?.provider_sid) {
    if (row?.state === 'UNKNOWN') {
      await env.DB
        .prepare("UPDATE sms_deliveries SET last_error='No provider SID is available. Check Twilio logs before deciding whether to send a new message.', updated_at=? WHERE id=?")
        .bind(now.toISOString(), id)
        .run();
      return getDelivery(env.DB, id);
    }
    return row;
  }
  const current = await getSmsStatus(env, row.provider_sid, fetcher);
  await updateDeliveryStatus(env, row.provider_sid, current.status, current.errorCode, now);
  return getDelivery(env.DB, id);
}
