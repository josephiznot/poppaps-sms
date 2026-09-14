import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { Env } from '../src/types';
import { getGame } from '../src/lib/db';
import { deliveryIsStillValid, listDeliveries, requeueProviderOptOutTournamentInvites } from '../src/lib/delivery';
import { sendDueReminders } from '../src/lib/jobs';
import { automaticTournamentInvite } from '../src/lib/messages';
import { cancelTournament, rescheduleTournament, tickTournaments } from '../src/lib/tournament';
import { sms } from '../src/routes/sms';
import { createTestDb } from './d1-fixture';

const NOW = '2026-09-14T16:00:00.000Z';
const START = '2026-09-28T23:30:00.000Z';
const DEADLINE = '2026-09-21T15:00:00.000Z';
const DEALER = '+15550000999';

function fixture(options: { dealerHasOffer?: boolean; reminderDue?: boolean } = {}) {
  const { db, sqlite } = createTestDb();
  const env = {
    DB: db,
    PROGRAM_NAME: "Poppa P's Poker Night",
    TIMEZONE: 'America/Chicago',
    REMINDER_LEAD_HOURS: '24',
    VALIDATE_TWILIO_SIGNATURE: 'false',
  } as Env;
  const startsAt = options.reminderDue ? '2026-09-15T15:00:00.000Z' : START;
  sqlite.prepare(
    `INSERT INTO games(id,starts_at,location,is_tournament,reminder_sent,cancelled,created_at)
     VALUES('game',?,'Poppa P''s',1,0,0,?)`,
  ).run(startsAt, NOW);
  sqlite.prepare(
    `INSERT INTO tournament_plans
     (id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,confirmation_deadline,
      season_id,closed_at,created_at,updated_at)
     VALUES('plan','2026-Q4','game','ACTIVE',?,'2026-09-14T15:00:00.000Z',?,'season',
       '2026-09-14T15:00:00.000Z',?,?)`,
  ).run(startsAt, DEADLINE, NOW, NOW);
  sqlite.prepare("INSERT INTO seasons(id,closed_at,snapshot) VALUES('season','2026-09-14T15:00:00.000Z','{}')").run();

  for (let rank = 1; rank <= 8; rank++) {
    const phone = options.dealerHasOffer && rank === 8 ? DEALER : `+1555000000${rank}`;
    sqlite.prepare(
      `INSERT OR IGNORE INTO members(phone,display_name,status,awaiting_name,created_at,updated_at,is_designated_dealer)
       VALUES(?,?,'SUBSCRIBED',0,?,?,?)`,
    ).run(phone, `Player ${rank}`, NOW, NOW, phone === DEALER ? 1 : 0);
    sqlite.prepare(
      `INSERT INTO tournament_offers
       (id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at)
       VALUES(?, 'plan', ?, ?, 'ACTIVE', ?, ?, ?)`,
    ).run(`offer-${rank}`, phone, rank, NOW, DEADLINE, NOW);
  }
  if (!options.dealerHasOffer) {
    sqlite.prepare(
      `INSERT INTO members(phone,display_name,status,awaiting_name,created_at,updated_at,is_designated_dealer)
       VALUES(?,'Dealer D','SUBSCRIBED',0,?,?,1)`,
    ).run(DEALER, NOW, NOW);
  } else {
    sqlite.prepare(
      `INSERT INTO sms_deliveries
       (id,logical_key,plan_id,game_id,offer_id,recipient,kind,body,version,state,expires_at,created_at,updated_at)
       VALUES('dealer-player-invite','tournament:plan:initial-invite','plan','game','offer-8',?,
         'TOURNAMENT_INVITE','Player invitation',1,'QUEUED',?,?,?)`,
    ).run(DEALER, startsAt, NOW, NOW);
  }
  return { db, sqlite, env };
}

describe('designated dealer tournament SMS', () => {
  it('adds the reusable dealer flag to a legacy members table without assigning anyone', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const legacy = new DatabaseSync(':memory:');
    legacy.exec("CREATE TABLE members(phone TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'SUBSCRIBED')");
    legacy.exec("INSERT INTO members(phone) VALUES('+15550000123')");
    legacy.exec(readFileSync(resolve('migrations/0008_designated_dealer.sql'), 'utf8'));
    expect(legacy.prepare('SELECT is_designated_dealer FROM members').get()).toEqual({ is_designated_dealer: 0 });
    legacy.close();
  });

  it('uses the qualified-player invitation byte-for-byte without reserving a ninth player seat', async () => {
    const { db, sqlite, env } = fixture();

    const first = await tickTournaments(env, new Date(NOW));
    const second = await tickTournaments(env, new Date('2026-09-14T17:00:00.000Z'));

    expect(first.dealerNoticesQueued).toBe(1);
    expect(second.dealerNoticesQueued).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM tournament_offers WHERE state IN ('ACTIVE','CONFIRMED')").get()).toEqual({ n: 8 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM tournament_offers WHERE member_phone=?').get(DEALER)).toEqual({ n: 0 });
    const notices = (await listDeliveries(db, 'plan')).filter((d) => d.kind === 'DEALER_TOURNAMENT_NOTICE');
    const game = await getGame(db, 'game');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipient: DEALER, offer_id: null, state: 'QUEUED', expires_at: START });
    expect(notices[0]?.body).toBe(automaticTournamentInvite(env, game!, DEADLINE));
  });

  it('keeps an already-delivered current-version notice unchanged across later ticks', async () => {
    const { db, sqlite, env } = fixture();
    const originalBody = 'Previously delivered dealer notice copy';
    sqlite.prepare(
      `INSERT INTO sms_deliveries
       (id,logical_key,plan_id,game_id,recipient,kind,body,version,state,provider_sid,
        provider_status,provider_status_rank,expires_at,created_at,updated_at)
       VALUES('existing-dealer-notice','tournament:plan:dealer-notice:v1','plan','game',?,
        'DEALER_TOURNAMENT_NOTICE',?,1,'DELIVERED','SMexisting','delivered',30,?,?,?)`,
    ).run(DEALER, originalBody, START, NOW, NOW);

    const first = await tickTournaments(env, new Date(NOW));
    const second = await tickTournaments(env, new Date('2026-09-14T17:00:00.000Z'));
    const notices = (await listDeliveries(db, 'plan')).filter((d) => d.kind === 'DEALER_TOURNAMENT_NOTICE');

    expect(first.dealerNoticesQueued).toBe(0);
    expect(second.dealerNoticesQueued).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      id: 'existing-dealer-notice',
      logical_key: 'tournament:plan:dealer-notice:v1',
      version: 1,
      state: 'DELIVERED',
      body: originalBody,
    });
  });

  it('ensures a newly assigned dealer notice after player replies close and before play', async () => {
    const { db, sqlite, env } = fixture();
    sqlite.prepare('UPDATE members SET is_designated_dealer=0 WHERE phone=?').run(DEALER);
    await tickTournaments(env, new Date(NOW));
    expect((await listDeliveries(db, 'plan')).filter((d) => d.kind === 'DEALER_TOURNAMENT_NOTICE')).toHaveLength(0);

    sqlite.prepare('UPDATE members SET is_designated_dealer=1 WHERE phone=?').run(DEALER);
    const late = await tickTournaments(env, new Date('2026-09-22T16:00:00.000Z'));
    const notice = (await listDeliveries(db, 'plan')).find((d) => d.kind === 'DEALER_TOURNAMENT_NOTICE');

    expect(late.dealerNoticesQueued).toBe(1);
    expect(notice).toMatchObject({ recipient: DEALER, expires_at: START, state: 'QUEUED' });
    expect(notice?.body).toBe(automaticTournamentInvite(env, (await getGame(db, 'game'))!, DEADLINE));

    sqlite.prepare("UPDATE sms_deliveries SET state='FAILED',last_error_code='21610',last_error='opted out' WHERE id=?")
      .run(notice!.id);
    expect(await requeueProviderOptOutTournamentInvites(db, DEALER, new Date('2026-09-22T17:00:00.000Z'))).toBe(1);
    expect(sqlite.prepare('SELECT state FROM sms_deliveries WHERE id=?').get(notice!.id)).toEqual({ state: 'QUEUED' });
  });

  it('deduplicates a qualified dealer to the normal player path for notice and reminder', async () => {
    const { db, env } = fixture({ dealerHasOffer: true, reminderDue: true });

    await tickTournaments(env, new Date(NOW));
    await sendDueReminders(env, new Date(NOW));

    const dealerMessages = (await listDeliveries(db, 'plan')).filter((d) => d.recipient === DEALER);
    expect(dealerMessages.map((d) => d.kind).sort()).toEqual(['TOURNAMENT_INVITE', 'TOURNAMENT_REMINDER']);
    const reminder = dealerMessages.find((d) => d.kind === 'TOURNAMENT_REMINDER');
    expect(reminder?.body).toContain("your seat's waiting");
    expect(dealerMessages.every((d) => !d.kind.startsWith('DEALER_'))).toBe(true);
  });

  it('queues dealer-specific night-before copy while preserving eight player reminders', async () => {
    const { db, env } = fixture({ reminderDue: true });
    await tickTournaments(env, new Date(NOW));

    const result = await sendDueReminders(env, new Date(NOW));
    const deliveries = await listDeliveries(db, 'plan');
    const reminder = deliveries.find((d) => d.kind === 'DEALER_TOURNAMENT_REMINDER');

    expect(result.queued).toBe(9);
    expect(deliveries.filter((d) => d.kind === 'TOURNAMENT_REMINDER')).toHaveLength(8);
    expect(reminder).toMatchObject({ recipient: DEALER, offer_id: null });
    expect(reminder?.body).toContain('designated dealer');
    expect(reminder?.body).toContain('not a player seat');
    expect(await sendDueReminders(env, new Date('2026-09-14T17:00:00.000Z'))).toEqual({ games: 0, queued: 0 });
  });

  it('sends one versioned dealer update and one cancellation after a prior accepted notice', async () => {
    const { db, sqlite, env } = fixture();
    await tickTournaments(env, new Date(NOW));
    sqlite.prepare("UPDATE sms_deliveries SET state='ACCEPTED',provider_sid='SMdealer',provider_status='queued',provider_status_rank=10 WHERE kind='DEALER_TOURNAMENT_NOTICE'").run();

    const rescheduled = await rescheduleTournament(env, 'plan', '2026-10-26', new Date(NOW), 1);
    const changed = (await listDeliveries(db, 'plan')).filter((d) => d.kind === 'DEALER_TOURNAMENT_DATE_CHANGE');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ recipient: DEALER, version: 2 });
    expect(changed[0]?.body).toContain('Designated dealer update');
    sqlite.prepare("UPDATE sms_deliveries SET state='ACCEPTED',provider_sid='SMchange',provider_status='queued',provider_status_rank=10 WHERE kind='DEALER_TOURNAMENT_DATE_CHANGE'").run();

    await cancelTournament(env, 'plan', new Date('2026-09-14T17:00:00.000Z'), rescheduled.plan!.version);
    await cancelTournament(env, 'plan', new Date('2026-09-14T18:00:00.000Z'));
    const cancellations = (await listDeliveries(db, 'plan')).filter((d) => d.kind === 'DEALER_TOURNAMENT_CANCELLED');
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]?.body).toContain('scheduled to deal has been cancelled');
  });

  it('lets STOP win and narrowly recovers only a valid no-SID 21610 dealer notice after rejoin', async () => {
    const { db, sqlite, env } = fixture();
    await tickTournaments(env, new Date(NOW));
    const notice = (await listDeliveries(db, 'plan')).find((d) => d.kind === 'DEALER_TOURNAMENT_NOTICE')!;
    sqlite.prepare(
      "UPDATE sms_deliveries SET state='FAILED',last_error_code='21610',last_error='opted out',failed_at=?,attempt_count=1 WHERE id=?",
    ).run(NOW, notice.id);
    sqlite.prepare("UPDATE members SET status='UNSUBSCRIBED' WHERE phone=?").run(DEALER);
    expect(await deliveryIsStillValid(db, notice, NOW)).toBe(false);
    expect(await requeueProviderOptOutTournamentInvites(db, DEALER, new Date(NOW))).toBe(0);

    const app = new Hono<{ Bindings: Env }>().route('/sms', sms);
    const response = await app.request(
      'https://example.test/sms',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: DEALER, Body: 'UNSTOP', OptOutType: 'START' }).toString(),
      },
      env,
    );
    expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(sqlite.prepare('SELECT state,last_error_code,provider_sid FROM sms_deliveries WHERE id=?').get(notice.id))
      .toEqual({ state: 'QUEUED', last_error_code: null, provider_sid: null });

    sqlite.prepare("UPDATE sms_deliveries SET state='FAILED',last_error_code='21610',provider_sid='SMaccepted' WHERE id=?").run(notice.id);
    expect(await requeueProviderOptOutTournamentInvites(db, DEALER, new Date(NOW))).toBe(0);
  });
});
