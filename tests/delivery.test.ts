import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import { drainOutbox, listDeliveries, queueDelivery, reconcileDelivery, updateDeliveryStatus } from '../src/lib/delivery';
import { TwilioSendError } from '../src/lib/twilio';
import { createTestDb } from './d1-fixture';

function fixture() {
  const { db } = createTestDb();
  const env = { DB: db } as Env;
  return { db, env };
}

async function memberAndPromo(db: D1Database, now: string) {
  const phone = '+15550001111';
  await db.prepare(
    "INSERT INTO members(phone,status,awaiting_name,created_at,updated_at) VALUES(?,'SUBSCRIBED',0,?,?)",
  ).bind(phone, now, now).run();
  const id = await queueDelivery(db, {
    logicalKey: 'promo:test', recipient: phone, kind: 'PROMO', body: 'Test', now,
  });
  return { id, phone };
}

describe('durable SMS delivery', () => {
  it('does not regress a final callback that arrives before the send response is persisted', async () => {
    const { db, env } = fixture();
    const now = '2026-09-28T15:00:00.000Z';
    const { id } = await memberAndPromo(db, now);
    await drainOutbox(env, new Date(now), {
      paceMs: 0,
      clock: () => new Date(now),
      transport: async (_env, _to, _body, deliveryId) => {
        await updateDeliveryStatus(env, 'SMfast', 'delivered', null, new Date(now), deliveryId);
        return { sid: 'SMfast', status: 'queued' };
      },
    });
    const row = (await listDeliveries(db))[0]!;
    expect(row.id).toBe(id);
    expect(row.state).toBe('DELIVERED');
    expect(row.provider_status).toBe('delivered');
  });

  it('quarantines ambiguous transport failure and only retries definite rate limits on a later tick', async () => {
    const { db, env } = fixture();
    const start = '2026-09-28T15:00:00.000Z';
    await memberAndPromo(db, start);
    await drainOutbox(env, new Date(start), {
      paceMs: 0, clock: () => new Date(start), transport: async () => { throw new Error('connection lost'); },
    });
    expect((await listDeliveries(db))[0]?.state).toBe('UNKNOWN');
    const reconciled = await reconcileDelivery(env, (await listDeliveries(db))[0]!.id, new Date(start));
    expect(reconciled?.last_error).toContain('Check Twilio logs');

    const second = await queueDelivery(db, {
      logicalKey: 'promo:rate-limit', recipient: '+15550001111', kind: 'PROMO', body: 'Test', now: start,
    });
    let calls = 0;
    await drainOutbox(env, new Date(start), {
      paceMs: 0,
      clock: () => new Date(start),
      transport: async () => { calls++; throw new TwilioSendError('rate limited', 429, '20429', true); },
    });
    expect(calls).toBe(1);
    expect((await listDeliveries(db)).find((d) => d.id === second)?.state).toBe('FAILED');
  });
});
