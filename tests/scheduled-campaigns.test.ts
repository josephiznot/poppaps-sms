import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { drainOutbox, listDeliveries, queueDelivery, queueDueCampaigns } from '../src/lib/delivery';
import { createTestDb } from './d1-fixture';

const createdAt = '2026-09-27T20:00:00.000Z';
const scheduledAt = '2026-09-28T15:00:00.000Z';
const expiresAt = '2026-09-28T16:00:00.000Z';
const gameStart = '2026-10-26T23:30:00.000Z';
const phone = '+15550001111';
const body = 'Approved custom game invitation';

function fixture() {
  const { db, sqlite } = createTestDb();
  const env = { DB: db } as Env;
  sqlite.prepare(
    "INSERT INTO members(phone,status,awaiting_name,created_at,updated_at) VALUES(?,'SUBSCRIBED',0,?,?)",
  ).run(phone, createdAt, createdAt);
  sqlite.prepare(
    `INSERT INTO games(id,starts_at,location,sms_hold,created_at)
     VALUES('custom-game',?,'Poppa P''s',1,?)`,
  ).run(gameStart, createdAt);
  return { db, sqlite, env };
}

function insertCampaign(
  sqlite: ReturnType<typeof createTestDb>['sqlite'],
  values: { approvedAt?: string | null; queuedAt?: string | null; cancelledAt?: string | null } = {},
) {
  sqlite.prepare(
    `INSERT INTO sms_campaigns
     (id,game_id,body,scheduled_at,expires_at,approved_at,queued_at,cancelled_at,created_at)
     VALUES('campaign-1','custom-game',?,?,?,?,?,?,?)`,
  ).run(
    body,
    scheduledAt,
    expiresAt,
    values.approvedAt === undefined ? createdAt : values.approvedAt,
    values.queuedAt ?? null,
    values.cancelledAt ?? null,
    createdAt,
  );
}

async function queueCampaignDelivery(
  db: D1Database,
  overrides: { campaignId?: string | null; gameId?: string; body?: string; expiresAt?: string } = {},
) {
  return queueDelivery(db, {
    logicalKey: `campaign:${overrides.campaignId ?? 'campaign-1'}:invite`,
    campaignId: overrides.campaignId === undefined ? 'campaign-1' : overrides.campaignId,
    gameId: overrides.gameId ?? 'custom-game',
    recipient: phone,
    kind: 'CAMPAIGN_INVITE',
    body: overrides.body ?? body,
    expiresAt: overrides.expiresAt ?? expiresAt,
    now: createdAt,
  });
}

async function drainWithCounter(env: Env, at: string) {
  let calls = 0;
  const result = await drainOutbox(env, new Date(at), {
    paceMs: 0,
    clock: () => new Date(at),
    transport: async () => {
      calls++;
      return { sid: `SM-${calls}`, status: 'queued' };
    },
  });
  return { calls, result };
}

describe('scheduled SMS campaigns', () => {
  it('migrates existing deliveries with no campaign association', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`
      CREATE TABLE sms_deliveries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      INSERT INTO sms_deliveries(id,created_at) VALUES('existing','${createdAt}');
    `);

    legacy.exec(readFileSync(resolve('migrations/0013_scheduled_sms_campaigns.sql'), 'utf8'));

    expect(legacy.prepare('SELECT campaign_id FROM sms_deliveries WHERE id=?').get('existing')).toEqual({ campaign_id: null });
    expect(legacy.prepare("SELECT name FROM pragma_table_info('sms_campaigns') WHERE name='queued_at'").get()).toEqual({ name: 'queued_at' });
  });

  it('snapshots subscribers only once when due and sends each delivery once', async () => {
    const { db, sqlite, env } = fixture();
    insertCampaign(sqlite);

    expect(await queueDueCampaigns(env, new Date('2026-09-28T14:59:59.000Z'))).toBe(0);
    expect(await listDeliveries(db)).toEqual([]);
    expect(sqlite.prepare('SELECT queued_at FROM sms_campaigns').get()).toEqual({ queued_at: null });

    expect(await queueDueCampaigns(env, new Date(scheduledAt))).toBe(1);
    expect((await listDeliveries(db))).toMatchObject([
      { campaign_id: 'campaign-1', game_id: 'custom-game', recipient: phone, kind: 'CAMPAIGN_INVITE', state: 'QUEUED' },
    ]);
    sqlite.prepare(
      "INSERT INTO members(phone,status,awaiting_name,created_at,updated_at) VALUES('+15550002222','SUBSCRIBED',0,?,?)",
    ).run(scheduledAt, scheduledAt);
    expect(await queueDueCampaigns(env, new Date(scheduledAt))).toBe(0);
    expect(await listDeliveries(db)).toHaveLength(1);

    expect(await drainWithCounter(env, scheduledAt)).toMatchObject({ calls: 1, result: { accepted: 1 } });
    expect(await drainWithCounter(env, scheduledAt)).toMatchObject({ calls: 0, result: { accepted: 0 } });
  });

  it('does not let an earlier-created future campaign block ordinary due work', async () => {
    const { db, sqlite, env } = fixture();
    insertCampaign(sqlite, { queuedAt: createdAt });
    await queueCampaignDelivery(db);
    await queueDelivery(db, {
      logicalKey: 'promo:due', recipient: phone, kind: 'PROMO', body: 'Due now', now: '2026-09-27T21:00:00.000Z',
    });

    const drained = await drainOutbox(env, new Date('2026-09-28T14:00:00.000Z'), {
      limit: 1,
      paceMs: 0,
      clock: () => new Date('2026-09-28T14:00:00.000Z'),
      transport: async () => ({ sid: 'SMpromo', status: 'queued' }),
    });

    expect(drained.accepted).toBe(1);
    expect((await listDeliveries(db)).find((row) => row.kind === 'PROMO')?.state).toBe('ACCEPTED');
    expect((await listDeliveries(db)).find((row) => row.kind === 'CAMPAIGN_INVITE')).toMatchObject({ state: 'QUEUED', attempt_count: 0 });
  });

  it('allows an approved campaign invitation through a game hold while suppressing a held reminder', async () => {
    const { db, sqlite, env } = fixture();
    insertCampaign(sqlite, { queuedAt: scheduledAt });
    await queueCampaignDelivery(db);
    await queueDelivery(db, {
      logicalKey: 'game:custom-game:reminder:v1', recipient: phone, kind: 'REGULAR_REMINDER',
      body: 'Automatic reminder', now: createdAt, gameId: 'custom-game', expiresAt: gameStart,
    });

    const { calls, result } = await drainWithCounter(env, scheduledAt);

    expect(calls).toBe(1);
    expect(result).toMatchObject({ accepted: 1, suppressed: 1 });
    expect((await listDeliveries(db)).find((row) => row.kind === 'CAMPAIGN_INVITE')?.state).toBe('ACCEPTED');
    expect((await listDeliveries(db)).find((row) => row.kind === 'REGULAR_REMINDER')?.state).toBe('SUPPRESSED');
  });

  it.each([
    ['missing campaign', 'missing'],
    ['unapproved campaign', 'unapproved'],
    ['cancelled campaign', 'cancelled'],
    ['wrong body', 'body'],
    ['wrong game', 'game'],
    ['opted-out recipient', 'optedout'],
    ['past game', 'past'],
  ])('suppresses %s without calling the provider', async (_label, invalid) => {
    const { db, sqlite, env } = fixture();
    if (invalid !== 'missing') {
      insertCampaign(sqlite, {
        approvedAt: invalid === 'unapproved' ? null : createdAt,
        queuedAt: scheduledAt,
        cancelledAt: invalid === 'cancelled' ? createdAt : null,
      });
    }
    if (invalid === 'game') {
      sqlite.prepare("INSERT INTO games(id,starts_at,location,created_at) VALUES('other-game',?,'Poppa P''s',?)")
        .run(gameStart, createdAt);
    }
    if (invalid === 'optedout') sqlite.prepare("UPDATE members SET status='UNSUBSCRIBED' WHERE phone=?").run(phone);
    if (invalid === 'past') sqlite.prepare('UPDATE games SET starts_at=? WHERE id=?').run(createdAt, 'custom-game');
    await queueCampaignDelivery(db, {
      campaignId: invalid === 'missing' ? 'missing' : 'campaign-1',
      body: invalid === 'body' ? 'Tampered copy' : body,
      gameId: invalid === 'game' ? 'other-game' : 'custom-game',
    });

    const { calls } = await drainWithCounter(env, scheduledAt);

    expect(calls).toBe(0);
    expect((await listDeliveries(db))[0]?.state).toBe('SUPPRESSED');
  });

  it('suppresses an expired campaign without a provider call', async () => {
    const { db, sqlite, env } = fixture();
    insertCampaign(sqlite, { queuedAt: scheduledAt });
    await queueCampaignDelivery(db);

    const { calls } = await drainWithCounter(env, expiresAt);

    expect(calls).toBe(0);
    expect((await listDeliveries(db))[0]).toMatchObject({ state: 'SUPPRESSED', attempt_count: 0 });
  });
});
