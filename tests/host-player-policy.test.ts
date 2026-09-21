import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Env } from '../src/types';
import { deliveryIsStillValid, listDeliveries, requeueProviderOptOutTournamentInvites } from '../src/lib/delivery';
import { sendDueReminders } from '../src/lib/jobs';
import { cancelTournament, getTournamentSummary, rescheduleTournament, respondToTournamentOffer, tickTournaments } from '../src/lib/tournament';
import { tournamentOffers } from '../src/lib/tournament-db';
import { addDaysToKey, localDateInTz } from '../src/lib/schedule';
import { sms } from '../src/routes/sms';
import { createTestDb } from './d1-fixture';

const envFor = (db: D1Database): Env => ({
  DB: db,
  PROGRAM_NAME: "Poppa P's Poker Night",
  TIMEZONE: 'America/Chicago',
  REMINDER_LEAD_HOURS: '24',
  PUBLIC_BASE_URL: 'https://example.test',
  VALIDATE_TWILIO_SIGNATURE: 'false',
} as Env);

async function qualifiedFixture(hostIndex: number, hostStatus: 'SUBSCRIBED' | 'UNSUBSCRIBED' = 'SUBSCRIBED', tiedTail = false) {
  const { db, sqlite } = createTestDb();
  const env = envFor(db);
  await tickTournaments(env, new Date('2026-03-01T12:00:00.000Z'));
  const at = '2026-03-10T23:30:00.000Z';
  await db.prepare(
    `INSERT INTO games(id,starts_at,location,is_tournament,created_at,scoring_at,results_recorded_at,result_version)
     VALUES('regular',?,'Lounge',0,?,?,?,1)`,
  ).bind(at, at, at, at).run();
  const phones: string[] = [];
  for (let i = 0; i < 10; i++) {
    const phone = `+155511100${i}`;
    phones.push(phone);
    const points = tiedTail && i >= 8 ? 2 : 10 - i;
    await db.prepare(
      `INSERT INTO members(phone,display_name,status,awaiting_name,created_at,updated_at,is_designated_dealer)
       VALUES(?,?,?,0,?,?,?)`,
    ).bind(phone, `Player ${i + 1}`, i === hostIndex ? hostStatus : 'SUBSCRIBED', at, at, i === hostIndex ? 1 : 0).run();
    await db.prepare(
      'INSERT INTO points_ledger(id,member_phone,game_id,points,place,awarded_at) VALUES(?,?,?,?,?,?)',
    ).bind(`points-${i}`, phone, 'regular', points, Math.min(i + 1, 5), at).run();
  }
  await tickTournaments(env, new Date('2026-03-30T16:00:00.000Z'));
  const summary = await getTournamentSummary(db, new Date('2026-03-30T16:00:00.000Z'));
  return { db, sqlite, env, phones, plan: summary.plan! };
}

describe('designated host is a tournament player', () => {
  it('creates exactly eight actionable invitations when the host is selected in the top eight', async () => {
    const { db, phones, plan } = await qualifiedFixture(0);
    const offers = await tournamentOffers(db, plan.id);
    const deliveries = await listDeliveries(db, plan.id);

    expect(offers).toHaveLength(8);
    expect(offers.every((offer) => offer.state === 'ACTIVE')).toBe(true);
    expect(offers.filter((offer) => offer.is_host_offer)).toMatchObject([
      { member_phone: phones[0], counts_ranked_seat: 1 },
    ]);
    expect(deliveries.filter((delivery) => delivery.kind === 'TOURNAMENT_INVITE')).toHaveLength(8);
    expect(deliveries.filter((delivery) => delivery.kind.startsWith('DEALER_'))).toHaveLength(0);
  });

  it('creates nine actionable invitations when the host is outside the selected top eight', async () => {
    const { db, phones, plan } = await qualifiedFixture(9);
    const offers = await tournamentOffers(db, plan.id);
    const deliveries = await listDeliveries(db, plan.id);

    expect(offers).toHaveLength(9);
    expect(offers.every((offer) => offer.state === 'ACTIVE')).toBe(true);
    expect(offers.filter((offer) => offer.counts_ranked_seat === 1)).toHaveLength(8);
    expect(offers.find((offer) => offer.member_phone === phones[9])).toMatchObject({ is_host_offer: 1, counts_ranked_seat: 0 });
    const invitations = deliveries.filter((delivery) => delivery.kind === 'TOURNAMENT_INVITE');
    expect(invitations).toHaveLength(9);
    expect(new Set(invitations.map((delivery) => delivery.body))).toHaveLength(1);
    expect(deliveries.filter((delivery) => delivery.kind.startsWith('DEALER_'))).toHaveLength(0);
  });

  it('excludes the separately offered host from a lower-ranked replacement tie', async () => {
    const { db, env, phones, plan } = await qualifiedFixture(8, 'SUBSCRIBED', true);
    const folded = await respondToTournamentOffer(env, phones[0]!, 'DECLINE', new Date('2026-03-31T12:00:00.000Z'));
    expect(folded.outcome).toBe('DECLINED');

    const summary = await getTournamentSummary(db, new Date('2026-03-31T12:00:00.000Z'));
    expect(summary.plan?.blocked_reason).toBeNull();
    expect(summary.offers.find((offer) => offer.member_phone === phones[9])).toMatchObject({ state: 'ACTIVE', counts_ranked_seat: 1 });
    expect(summary.offers.find((offer) => offer.member_phone === phones[8])).toMatchObject({ state: 'ACTIVE', counts_ranked_seat: 0 });
    expect(summary.offers.filter((offer) => ['ACTIVE', 'CONFIRMED'].includes(offer.state) && offer.counts_ranked_seat === 1)).toHaveLength(8);
  });

  it('keeps an unsubscribed host offer past cutoff, sends no SMS, and accepts FOLD', async () => {
    const { db, env, phones, plan } = await qualifiedFixture(9, 'UNSUBSCRIBED');
    let offers = await tournamentOffers(db, plan.id);
    const hostOffer = offers.find((offer) => offer.member_phone === phones[9])!;
    expect(hostOffer).toMatchObject({ state: 'ACTIVE', is_host_offer: 1, counts_ranked_seat: 0 });
    expect((await listDeliveries(db, plan.id)).some((delivery) => delivery.recipient === phones[9])).toBe(false);

    await tickTournaments(env, new Date(plan.confirmation_deadline));
    offers = await tournamentOffers(db, plan.id);
    expect(offers.find((offer) => offer.id === hostOffer.id)?.state).toBe('ACTIVE');
    expect(offers.filter((offer) => offer.state === 'EXPIRED').length).toBeGreaterThan(0);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(plan.confirmation_deadline));
    try {
      const app = new Hono<{ Bindings: Env }>().route('/sms', sms);
      const response = await app.request('https://example.test/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: phones[9]!, Body: 'FOLD' }).toString(),
      }, env);
      expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    } finally {
      vi.useRealTimers();
    }
    expect((await tournamentOffers(db, plan.id)).find((offer) => offer.id === hostOffer.id)?.state).toBe('DECLINED');
  });

  it('suppresses queued host SMS after opt-out while retaining the offer', async () => {
    const { db, sqlite, phones, plan } = await qualifiedFixture(9);
    const delivery = (await listDeliveries(db, plan.id)).find((row) => row.recipient === phones[9])!;
    sqlite.prepare("UPDATE members SET status='UNSUBSCRIBED' WHERE phone=?").run(phones[9]!);
    await tickTournaments(envFor(db), new Date('2026-03-31T12:00:00.000Z'));
    expect((await tournamentOffers(db, plan.id)).find((offer) => offer.member_phone === phones[9])?.state).toBe('ACTIVE');
    expect(await deliveryIsStillValid(db, delivery, '2026-03-31T12:00:00.000Z')).toBe(false);
  });

  it('reconciles one host reminder after resubscription without duplicating earlier recipients', async () => {
    const { db, sqlite, env, phones, plan } = await qualifiedFixture(9);
    const start = new Date(plan.planned_starts_at);
    const firstTick = new Date(start.getTime() - 12 * 60 * 60 * 1000);
    const secondTick = new Date(firstTick.getTime() + 60 * 60 * 1000);
    sqlite.prepare("UPDATE members SET status='UNSUBSCRIBED' WHERE phone=?").run(phones[9]!);

    const first = await sendDueReminders(env, firstTick);
    expect(first.queued).toBe(8);
    expect(sqlite.prepare('SELECT reminder_sent FROM games WHERE id=?').get(plan.game_id)).toEqual({ reminder_sent: 1 });
    expect((await listDeliveries(db, plan.id)).filter((row) => row.kind === 'TOURNAMENT_REMINDER' && row.recipient === phones[9])).toHaveLength(0);

    sqlite.prepare("UPDATE members SET status='SUBSCRIBED' WHERE phone=?").run(phones[9]!);
    const second = await sendDueReminders(env, secondTick);
    const third = await sendDueReminders(env, new Date(secondTick.getTime() + 60 * 60 * 1000));
    const reminders = (await listDeliveries(db, plan.id)).filter((row) => row.kind === 'TOURNAMENT_REMINDER');

    expect(second).toEqual({ games: 0, queued: 1 });
    expect(third).toEqual({ games: 0, queued: 0 });
    expect(reminders).toHaveLength(9);
    expect(reminders.filter((row) => row.recipient === phones[9])).toHaveLength(1);
    expect(new Set(reminders.map((row) => `${row.logical_key}:${row.recipient}`)).size).toBe(9);
  });

  it('uses the ordinary offer-linked path for host reschedule and cancellation', async () => {
    const { db, sqlite, env, phones, plan } = await qualifiedFixture(9);
    const hostOffer = (await tournamentOffers(db, plan.id)).find((offer) => offer.member_phone === phones[9])!;
    sqlite.prepare(
      "UPDATE sms_deliveries SET state='ACCEPTED',provider_sid='SMhost',provider_status='queued',provider_status_rank=10 WHERE offer_id=? AND kind='TOURNAMENT_INVITE'",
    ).run(hostOffer.id);
    const originalDate = localDateInTz(new Date(plan.planned_starts_at), env.TIMEZONE);
    const newDate = addDaysToKey(originalDate, 14);

    const rescheduled = await rescheduleTournament(env, plan.id, newDate, new Date('2026-03-31T12:00:00.000Z'), plan.version);
    const dateChanges = (await listDeliveries(db, plan.id)).filter(
      (row) => row.recipient === phones[9] && row.kind === 'TOURNAMENT_DATE_CHANGE',
    );
    expect(dateChanges).toHaveLength(1);
    expect(dateChanges[0]).toMatchObject({ offer_id: hostOffer.id, version: 2 });
    expect(dateChanges[0]?.body).toContain('Your current RSVP still applies');

    await cancelTournament(env, plan.id, new Date('2026-04-01T12:00:00.000Z'), rescheduled.plan!.version);
    await cancelTournament(env, plan.id, new Date('2026-04-01T13:00:00.000Z'));
    const cancellations = (await listDeliveries(db, plan.id)).filter(
      (row) => row.recipient === phones[9] && row.kind === 'TOURNAMENT_CANCELLED',
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({ offer_id: hostOffer.id });
    expect((await listDeliveries(db, plan.id)).filter((row) => row.kind.startsWith('DEALER_'))).toHaveLength(0);
  });

  it('recovers only the existing offer-linked host invite after signed START', async () => {
    const { db, sqlite, env, phones, plan } = await qualifiedFixture(9);
    const hostOffer = (await tournamentOffers(db, plan.id)).find((offer) => offer.member_phone === phones[9])!;
    const invite = (await listDeliveries(db, plan.id)).find(
      (row) => row.offer_id === hostOffer.id && row.kind === 'TOURNAMENT_INVITE',
    )!;
    sqlite.prepare(
      "UPDATE sms_deliveries SET state='FAILED',last_error_code='21610',last_error='opted out',failed_at=?,attempt_count=1 WHERE id=?",
    ).run('2026-03-31T12:00:00.000Z', invite.id);
    sqlite.prepare("UPDATE members SET status='UNSUBSCRIBED' WHERE phone=?").run(phones[9]!);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    try {
      const app = new Hono<{ Bindings: Env }>().route('/sms', sms);
      const response = await app.request('https://example.test/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: phones[9]!, Body: 'UNSTOP', OptOutType: 'START' }).toString(),
      }, env);
      expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    } finally {
      vi.useRealTimers();
    }

    expect(sqlite.prepare('SELECT state,last_error_code,provider_sid,attempt_count FROM sms_deliveries WHERE id=?').get(invite.id)).toEqual({
      state: 'QUEUED', last_error_code: null, provider_sid: null, attempt_count: 1,
    });
    expect((await listDeliveries(db, plan.id)).filter((row) => row.recipient === phones[9] && row.kind === 'TOURNAMENT_INVITE')).toHaveLength(1);

    sqlite.prepare("UPDATE sms_deliveries SET state='FAILED',last_error_code='21610',provider_sid='SMaccepted' WHERE id=?").run(invite.id);
    expect(await requeueProviderOptOutTournamentInvites(db, phones[9]!, new Date('2026-03-31T13:00:00.000Z'))).toBe(0);
  });
});

describe('2026-Q4 host-offer migration', () => {
  it('links the delivered exact-copy notice without rewriting delivery or history and reruns safely', async () => {
    const { db, sqlite } = createTestDb();
    const env = envFor(db);
    const now = '2026-09-21T18:00:00.000Z';
    sqlite.exec(`
      DROP TRIGGER trg_tournament_offer_capacity_insert;
      DROP TRIGGER trg_tournament_offer_capacity_update;
      DROP TABLE tournament_host_offers;
      CREATE TRIGGER trg_tournament_offer_capacity_insert BEFORE INSERT ON tournament_offers
      WHEN NEW.state IN ('ACTIVE','CONFIRMED') AND
        (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=NEW.plan_id AND state IN ('ACTIVE','CONFIRMED')) >= 8
      BEGIN SELECT RAISE(ABORT, 'tournament offer capacity exceeded'); END;
      CREATE TRIGGER trg_tournament_offer_capacity_update BEFORE UPDATE OF state ON tournament_offers
      WHEN OLD.state NOT IN ('ACTIVE','CONFIRMED') AND NEW.state IN ('ACTIVE','CONFIRMED') AND
        (SELECT COUNT(*) FROM tournament_offers WHERE plan_id=NEW.plan_id AND state IN ('ACTIVE','CONFIRMED')) >= 8
      BEGIN SELECT RAISE(ABORT, 'tournament offer capacity exceeded'); END;
    `);
    sqlite.exec(`
      INSERT INTO games(id,starts_at,location,is_tournament,cancelled,created_at)
      VALUES('q4-game','2026-09-28T23:30:00.000Z','Lounge',1,0,'2026-09-13T00:00:00.000Z');
      INSERT INTO seasons(id,closed_at,snapshot) VALUES('q4-season','2026-09-14T15:00:00.000Z','{}');
      INSERT INTO tournament_plans(
        id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,confirmation_deadline,
        season_id,blocked_reason,tie_score,version,schedule_version,closed_at,created_at,updated_at
      ) VALUES(
        'q4-plan','2026-Q4','q4-game','ACTIVE','2026-09-28T23:30:00.000Z','2026-09-14T15:00:00.000Z',
        '2026-09-22T02:00:00.000Z','q4-season','2 replacement candidates are tied at 2 points for 1 seat.',2,5,1,
        '2026-09-14T15:00:00.000Z','2026-09-13T00:00:00.000Z','2026-09-21T17:00:00.000Z');
    `);
    for (let rank = 1; rank <= 10; rank++) {
      const phone = `+155522200${rank}`;
      sqlite.prepare(
        `INSERT INTO members(phone,display_name,status,awaiting_name,created_at,updated_at,is_designated_dealer)
         VALUES(?,?,'SUBSCRIBED',0,?,?,?)`,
      ).run(phone, rank === 9 ? 'Joseph H' : rank === 10 ? 'Gleason G' : `Player ${rank}`, now, now, rank === 9 ? 1 : 0);
      sqlite.prepare(
        `INSERT INTO tournament_board(plan_id,member_phone,display_name,rank,score_rank,points,scoring_tiebreak_at,was_subscribed,selected_qualifier)
         VALUES('q4-plan',?,?,?,?,?,?,1,?)`,
      ).run(phone, `Player ${rank}`, rank, rank, rank >= 9 ? 2 : 11 - rank, '2026-09-07T23:30:00.000Z', rank <= 8 ? 1 : 0);
      if (rank <= 7) {
        sqlite.prepare(
          `INSERT INTO tournament_offers(id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at)
           VALUES(?,'q4-plan',?,?,'ACTIVE','2026-09-14T15:00:00.000Z','2026-09-22T02:00:00.000Z',?)`,
        ).run(`offer-${rank}`, phone, rank, now);
      }
    }
    sqlite.prepare(
      `INSERT INTO tournament_offers(id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,retired_at,updated_at)
       VALUES('historic-offer','q4-plan','+1555222008',8,'EXPIRED','2026-09-14T15:00:00.000Z','2026-09-21T15:00:00.000Z',?,?)`,
    ).run('2026-09-21T15:00:00.000Z', '2026-09-21T15:00:00.000Z');
    sqlite.prepare(
      `INSERT INTO sms_deliveries(
        id,logical_key,plan_id,game_id,recipient,kind,body,version,state,provider_sid,provider_status,
        provider_status_rank,attempt_count,attempted_at,delivered_at,expires_at,created_at,updated_at
       ) VALUES(
        'host-delivery','tournament:q4-plan:dealer-notice:v1','q4-plan','q4-game','+1555222009',
        'DEALER_TOURNAMENT_NOTICE','EXACT ORIGINAL BODY',1,'DELIVERED','SM-original','delivered',100,1,
        '2026-09-14T15:01:00.000Z','2026-09-14T15:02:00.000Z','2026-09-28T23:30:00.000Z',
        '2026-09-14T15:00:00.000Z','2026-09-14T15:02:00.000Z')`,
    ).run();
    const migration = readFileSync(resolve('migrations/0010_host_player_policy.sql'), 'utf8');
    const deliveryBefore = sqlite.prepare('SELECT * FROM sms_deliveries WHERE id=?').get('host-delivery') as Record<string, unknown>;
    const historyBefore = sqlite.prepare('SELECT * FROM tournament_offers WHERE id=?').get('historic-offer');

    sqlite.exec(migration);
    sqlite.exec(migration);

    const deliveryAfter = sqlite.prepare('SELECT * FROM sms_deliveries WHERE id=?').get('host-delivery') as Record<string, unknown>;
    expect({ ...deliveryAfter, offer_id: null }).toEqual({ ...deliveryBefore, offer_id: null });
    expect(deliveryAfter.offer_id).toBe('host-player-offer-2026-q4');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM sms_deliveries').get()).toEqual({ n: 1 });
    expect(sqlite.prepare('SELECT * FROM tournament_offers WHERE id=?').get('historic-offer')).toEqual(historyBefore);
    expect(sqlite.prepare('SELECT version,schedule_version,blocked_reason,tie_score FROM tournament_plans WHERE id=?').get('q4-plan')).toEqual({
      version: 5, schedule_version: 1, blocked_reason: null, tie_score: null,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tournament_offers WHERE plan_id='q4-plan'").get()).toEqual({ n: 9 });

    const tick = await tickTournaments(env, new Date(now));
    expect(tick.offersQueued).toBe(1);
    expect((await tournamentOffers(db, 'q4-plan')).find((offer) => offer.member_phone === '+15552220010')).toMatchObject({
      state: 'ACTIVE', counts_ranked_seat: 1,
    });
  });
});
