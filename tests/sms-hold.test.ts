import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Env } from '../src/types';
import { sessionToken } from '../src/lib/auth';
import * as db from '../src/lib/db';
import { drainOutbox, listDeliveries, queueDelivery } from '../src/lib/delivery';
import { sendDueReminders } from '../src/lib/jobs';
import { admin } from '../src/routes/admin';
import { createTestDb } from './d1-fixture';

const now = '2026-10-25T23:30:00.000Z';
const heldStart = '2026-10-26T22:30:00.000Z';
const ordinaryStart = '2026-10-26T23:00:00.000Z';
const phone = '+15550001111';

function fixture() {
  const { db: database, sqlite } = createTestDb();
  const env = {
    DB: database,
    ADMIN_PASSWORD: 'test-only',
    PROGRAM_NAME: "Poppa P's Poker Night",
    SUPPORT_CONTACT: 'Ask the host',
    TIMEZONE: 'America/Chicago',
    TWILIO_FROM_NUMBER: '+16156951691',
    REMINDER_LEAD_HOURS: '24',
    PUBLIC_BASE_URL: 'https://example.test',
  } as Env;
  sqlite.prepare(
    "INSERT INTO members(phone,status,awaiting_name,created_at,updated_at) VALUES(?,'SUBSCRIBED',0,?,?)",
  ).run(phone, now, now);
  return { database, sqlite, env };
}

describe('per-game SMS hold', () => {
  it('migrates existing games to an unheld default', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`
      CREATE TABLE games (id TEXT PRIMARY KEY, starts_at TEXT NOT NULL);
      INSERT INTO games(id,starts_at) VALUES('existing','2026-10-26T23:30:00.000Z');
    `);

    legacy.exec(readFileSync(resolve('migrations/0012_game_sms_hold.sql'), 'utf8'));

    expect(legacy.prepare('SELECT sms_hold FROM games WHERE id=?').get('existing')).toEqual({ sms_hold: 0 });
    expect(() => legacy.prepare('UPDATE games SET sms_hold=2 WHERE id=?').run('existing')).toThrow();
  });

  it('keeps a held game on the host calendar but out of public and reminder queries', async () => {
    const { database, sqlite, env } = fixture();
    sqlite.prepare(
      `INSERT INTO games(id,starts_at,location,description,buy_in,sms_hold,created_at)
       VALUES('held',?,'Poppa P''s','Custom game night','$50',1,?)`,
    ).run(heldStart, now);
    sqlite.prepare(
      `INSERT INTO games(id,starts_at,location,description,buy_in,created_at)
       VALUES('ordinary',?,'Poppa P''s','Regular game night','$25',?)`,
    ).run(ordinaryStart, now);

    expect((await db.listGames(database)).map((game) => game.id)).toContain('held');
    expect((await db.nextUpcomingGame(database, now))?.id).toBe('ordinary');

    expect(await sendDueReminders(env, new Date(now))).toEqual({ games: 1, queued: 1 });
    expect((await listDeliveries(database)).map((delivery) => delivery.game_id)).toEqual(['ordinary']);
    expect(sqlite.prepare('SELECT reminder_sent FROM games WHERE id=?').get('held')).toEqual({ reminder_sent: 0 });
    expect(sqlite.prepare('SELECT reminder_sent FROM games WHERE id=?').get('ordinary')).toEqual({ reminder_sent: 1 });
  });

  it('suppresses a previously queued game message without calling the provider', async () => {
    const { database, sqlite, env } = fixture();
    sqlite.prepare(
      `INSERT INTO games(id,starts_at,location,sms_hold,created_at)
       VALUES('held',?,'Poppa P''s',1,?)`,
    ).run(heldStart, now);
    await queueDelivery(database, {
      logicalKey: 'game:held:reminder:v1',
      recipient: phone,
      kind: 'REGULAR_REMINDER',
      body: 'Held reminder',
      now,
      gameId: 'held',
      expiresAt: heldStart,
    });
    let providerCalls = 0;

    const result = await drainOutbox(env, new Date(now), {
      paceMs: 0,
      clock: () => new Date(now),
      transport: async () => {
        providerCalls++;
        return { sid: 'SMshould-not-send', status: 'queued' };
      },
    });

    expect(providerCalls).toBe(0);
    expect(result.suppressed).toBe(1);
    expect((await listDeliveries(database))[0]).toMatchObject({
      state: 'SUPPRESSED',
      last_error: 'Recipient or event no longer eligible',
    });
  });

  it('also excludes held tournaments from the hourly offer reconciliation', async () => {
    const { database, sqlite, env } = fixture();
    sqlite.exec(`
      INSERT INTO games(id,starts_at,location,is_tournament,reminder_sent,sms_hold,created_at)
      VALUES('held-tournament','${ordinaryStart}','Poppa P''s',1,1,1,'${now}');
      INSERT INTO tournament_plans(
        id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,confirmation_deadline,created_at,updated_at
      ) VALUES(
        'held-plan','2026-Q4','held-tournament','ACTIVE','${ordinaryStart}',
        '2026-10-12T23:00:00.000Z','2026-10-20T23:00:00.000Z','${now}','${now}'
      );
      INSERT INTO tournament_offers(id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at)
      VALUES('held-offer','held-plan','${phone}',1,'ACTIVE','${now}','2026-10-20T23:00:00.000Z','${now}');
    `);

    expect(await sendDueReminders(env, new Date(now))).toEqual({ games: 0, queued: 0 });
    expect(await listDeliveries(database, 'held-plan')).toEqual([]);
    expect(sqlite.prepare('SELECT reminder_sent FROM games WHERE id=?').get('held-tournament')).toEqual({ reminder_sent: 1 });
  });

  it('still dispatches a cancellation notice for an unheld cancelled game', async () => {
    const { database, sqlite, env } = fixture();
    sqlite.exec(`
      INSERT INTO games(id,starts_at,location,is_tournament,cancelled,created_at)
      VALUES('cancelled-tournament','${ordinaryStart}','Poppa P''s',1,1,'${now}');
      INSERT INTO tournament_plans(
        id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,confirmation_deadline,created_at,updated_at
      ) VALUES(
        'cancelled-plan','2026-Q4','cancelled-tournament','CANCELLED','${ordinaryStart}',
        '2026-10-12T23:00:00.000Z','2026-10-20T23:00:00.000Z','${now}','${now}'
      );
    `);
    await queueDelivery(database, {
      logicalKey: 'tournament:cancelled-plan:cancelled',
      recipient: phone,
      kind: 'TOURNAMENT_CANCELLED',
      body: 'Tournament cancelled',
      now,
      planId: 'cancelled-plan',
      gameId: 'cancelled-tournament',
    });
    let providerCalls = 0;

    const result = await drainOutbox(env, new Date(now), {
      paceMs: 0,
      clock: () => new Date(now),
      transport: async () => {
        providerCalls++;
        return { sid: 'SMcancelled', status: 'queued' };
      },
    });

    expect(providerCalls).toBe(1);
    expect(result.accepted).toBe(1);
  });

  it('labels held custom details clearly on the host games page', async () => {
    const { sqlite, env } = fixture();
    sqlite.prepare(
      `INSERT INTO games(id,starts_at,location,description,buy_in,sms_hold,created_at)
       VALUES('held',?,'Poppa P''s','Custom game night','$50',1,?)`,
    ).run(heldStart, now);
    const app = new Hono<{ Bindings: Env }>().route('/admin', admin);
    const cookie = `pp_session=${await sessionToken(env.ADMIN_PASSWORD)}`;

    const response = await app.request('https://example.test/admin/games', { headers: { cookie } }, env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Texts on hold');
    expect(html).toContain('Custom game night');
    expect(html).toContain('$50');
  });
});
