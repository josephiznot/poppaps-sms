import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sms } from '../src/routes/sms';
import { createTestDb } from './d1-fixture';
import type { Env, Member } from '../src/types';

const phone = '+15555550123';

function setup() {
  const { db, sqlite } = createTestDb();
  const env = {
    DB: db,
    PROGRAM_NAME: "Poppa P's Poker Night",
    PUBLIC_BASE_URL: 'https://poppaps.cards',
    SUPPORT_CONTACT: 'Ask the host',
    TIMEZONE: 'America/Chicago',
    VALIDATE_TWILIO_SIGNATURE: 'false',
  } as Env;
  const app = new Hono<{ Bindings: Env }>().route('/sms', sms);

  async function inbound(body: string, optOutType?: 'START' | 'STOP' | 'HELP') {
    const form = new URLSearchParams({ From: phone, Body: body });
    if (optOutType) form.set('OptOutType', optOutType);
    return app.request(
      'https://example.test/sms',
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
      env,
    );
  }

  const member = () => sqlite.prepare('SELECT * FROM members WHERE phone=?').get(phone) as unknown as Member | undefined;
  return { inbound, member, sqlite };
}

describe('SMS subscription lifecycle', () => {
  it('asks a new JOIN member for their name once and marks the name pending', async () => {
    const { inbound, member } = setup();
    const response = await inbound('JOIN');

    expect(await response.text()).toContain('Reply with your first name + last initial');
    expect(member()).toMatchObject({ status: 'SUBSCRIBED', awaiting_name: 1, display_name: null });

    const nameResponse = await inbound('Casey McKay');
    expect(await nameResponse.text()).toContain('Thanks Casey McKay!');
    expect(member()).toMatchObject({ status: 'SUBSCRIBED', awaiting_name: 0, display_name: 'Casey McKay' });
  });

  it('gives an already subscribed named member the existing already-on-list response', async () => {
    const { inbound, member } = setup();
    await inbound('JOIN');
    await inbound('Casey McKay');
    const before = member();

    const response = await inbound('JOIN');

    expect(await response.text()).toContain('already on the list');
    expect(member()).toMatchObject({
      display_name: 'Casey McKay',
      public_id: before?.public_id,
      status: 'SUBSCRIBED',
      awaiting_name: 0,
    });
  });

  it('preserves a named member identity across STOP then START and welcomes them back', async () => {
    const { inbound, member } = setup();
    await inbound('JOIN');
    await inbound('Casey McKay');
    const before = member();

    const stop = await inbound('STOP');
    expect(await stop.text()).toContain('<Response/>');
    expect(member()).toMatchObject({
      display_name: 'Casey McKay',
      public_id: before?.public_id,
      status: 'UNSUBSCRIBED',
      awaiting_name: 0,
    });

    const start = await inbound('START');
    const reply = await start.text();
    expect(reply).toContain('Welcome back, Casey McKay!');
    expect(reply).not.toContain('Reply with your first name');
    expect(member()).toMatchObject({
      display_name: 'Casey McKay',
      public_id: before?.public_id,
      status: 'SUBSCRIBED',
      awaiting_name: 0,
    });
  });

  it('asks a previously unnamed member for their name after STOP then START', async () => {
    const { inbound, member } = setup();
    await inbound('JOIN');
    const before = member();
    await inbound('STOP');

    const response = await inbound('START');

    expect(await response.text()).toContain('Reply with your first name + last initial');
    expect(member()).toMatchObject({
      display_name: null,
      public_id: before?.public_id,
      status: 'SUBSCRIBED',
      awaiting_name: 1,
    });
  });

  it.each(['START', 'UNSTOP', 'YES'])(
    'accepts provider-standard %s as reactivation without OptOutType',
    async (keyword) => {
      const { inbound, member } = setup();
      await inbound('JOIN');
      await inbound('Casey McKay');
      const before = member();
      await inbound('STOP');

      const response = await inbound(keyword);

      expect(await response.text()).toContain('Welcome back, Casey McKay!');
      expect(member()).toMatchObject({
        display_name: 'Casey McKay',
        public_id: before?.public_id,
        status: 'SUBSCRIBED',
        awaiting_name: 0,
      });
    },
  );

  it('uses OptOutType as authoritative and emits no duplicate lifecycle reply', async () => {
    const { inbound, member } = setup();
    await inbound('JOIN');
    await inbound('Casey McKay');
    const originalId = member()?.public_id;

    for (const [body, optOutType, status] of [
      ['anything', 'STOP', 'UNSUBSCRIBED'],
      ['anything', 'HELP', 'UNSUBSCRIBED'],
      ['anything', 'START', 'SUBSCRIBED'],
    ] as const) {
      const response = await inbound(body, optOutType);
      expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
      expect(member()).toMatchObject({
        display_name: 'Casey McKay',
        public_id: originalId,
        status,
        awaiting_name: 0,
      });
    }
  });

  it('requeues only the sender\'s still-valid no-SID 21610 tournament invite after provider-standard START', async () => {
    const { inbound, member, sqlite } = setup();
    await inbound('JOIN');
    await inbound('Grant H');
    const originalId = member()?.public_id;

    const addPlan = (
      suffix: string,
      options: { planStatus?: string; offerState?: string; deadline?: string; startsAt?: string; cancelled?: number } = {},
    ) => {
      const gameId = `game-${suffix}`;
      const planId = `plan-${suffix}`;
      const offerId = `offer-${suffix}`;
      const startsAt = options.startsAt ?? '2099-09-28T23:30:00.000Z';
      const deadline = options.deadline ?? '2099-09-21T15:00:00.000Z';
      sqlite.prepare(
        `INSERT INTO games (id,starts_at,location,is_tournament,cancelled,created_at)
         VALUES (?,?,?,1,?,?)`,
      ).run(gameId, startsAt, "Poppa P's", options.cancelled ?? 0, '2026-09-14T15:00:00.000Z');
      sqlite.prepare(
        `INSERT INTO tournament_plans
         (id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,
          confirmation_deadline,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        planId, `2099-${suffix}`, gameId, options.planStatus ?? 'ACTIVE', startsAt,
        '2099-09-14T15:00:00.000Z', deadline, '2026-09-14T15:00:00.000Z', '2026-09-14T15:00:00.000Z',
      );
      sqlite.prepare(
        `INSERT INTO tournament_offers
         (id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at)
         VALUES (?,?,?,1,?,?,?,?)`,
      ).run(
        offerId, planId, phone, options.offerState ?? 'ACTIVE',
        '2026-09-14T15:00:00.000Z', deadline, '2026-09-14T15:00:00.000Z',
      );
      return { gameId, planId, offerId };
    };
    const addDelivery = (
      id: string,
      links: { gameId: string; planId: string; offerId: string },
      options: { recipient?: string; kind?: string; state?: string; code?: string; sid?: string; expiresAt?: string } = {},
    ) => {
      sqlite.prepare(
        `INSERT INTO sms_deliveries
         (id,logical_key,plan_id,game_id,offer_id,recipient,kind,body,version,state,
          provider_sid,provider_status,provider_status_rank,retryable,attempt_count,
          claim_token,claimed_at,attempted_at,failed_at,last_error_code,last_error,
          expires_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,0,1,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, `logical-${id}`, links.planId, links.gameId, links.offerId,
        options.recipient ?? phone, options.kind ?? 'TOURNAMENT_INVITE', 'Invite', options.state ?? 'FAILED',
        options.sid ?? null, 'failed', options.state === 'ACCEPTED' || options.state === 'DELIVERED' ? 10 : 100,
        'stale-claim', '2026-09-14T15:00:00.000Z', '2026-09-14T15:00:00.000Z',
        '2026-09-14T15:00:01.000Z', options.code ?? '21610', 'Attempt to send to unsubscribed recipient',
        options.expiresAt ?? '2099-09-28T23:30:00.000Z', '2026-09-14T14:59:00.000Z', '2026-09-14T15:00:01.000Z',
      );
    };

    const current = addPlan('current');
    addDelivery('recover', current);
    addDelivery('wrong-code', current, { code: '30007' });
    addDelivery('known-sid', current, { sid: 'SMknown' });
    addDelivery('promo', current, { kind: 'PROMO' });
    for (const state of ['UNKNOWN', 'SENDING', 'ACCEPTED', 'DELIVERED'] as const) {
      addDelivery(state.toLowerCase(), current, { state });
    }
    addDelivery('delivery-expired', current, { expiresAt: '2000-01-01T00:00:00.000Z' });
    addDelivery('deadline-passed', addPlan('deadline', { deadline: '2000-01-01T00:00:00.000Z' }));
    addDelivery('inactive-offer', addPlan('offer', { offerState: 'CONFIRMED' }));
    addDelivery('inactive-plan', addPlan('plan', { planStatus: 'SCHEDULED' }));
    addDelivery('past-game', addPlan('past', { startsAt: '2000-01-01T00:00:00.000Z' }));
    addDelivery('cancelled-game', addPlan('cancelled', { cancelled: 1 }));

    sqlite.prepare(
      `INSERT INTO members (phone,display_name,status,awaiting_name,created_at,updated_at,public_id)
       VALUES ('+15555550999','Other P','SUBSCRIBED',0,'2026-09-14','2026-09-14','other-public-id')`,
    ).run();
    sqlite.prepare(
      `INSERT INTO tournament_offers
       (id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at)
       VALUES ('offer-other',?,'+15555550999',2,'ACTIVE','2026-09-14',?,'2026-09-14')`,
    ).run(current.planId, '2099-09-21T15:00:00.000Z');
    addDelivery('other-sender', { ...current, offerId: 'offer-other' }, { recipient: '+15555550999' });

    const bareJoin = await inbound('JOIN');
    expect(await bareJoin.text()).toContain('already on the list');
    expect(sqlite.prepare("SELECT state FROM sms_deliveries WHERE id='recover'").get()).toEqual({ state: 'FAILED' });

    const bareStart = await inbound('START');
    expect(await bareStart.text()).toContain('already on the list');
    expect(sqlite.prepare("SELECT state FROM sms_deliveries WHERE id='recover'").get()).toEqual({ state: 'QUEUED' });

    const providerStart = await inbound('anything', 'START');
    expect(await providerStart.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(member()).toMatchObject({
      display_name: 'Grant H',
      public_id: originalId,
      status: 'SUBSCRIBED',
      awaiting_name: 0,
    });

    const recovered = sqlite.prepare("SELECT * FROM sms_deliveries WHERE id='recover'").get() as Record<string, unknown>;
    expect(recovered).toMatchObject({
      state: 'QUEUED', retryable: 0, provider_sid: null, provider_status: null, provider_status_rank: 0,
      attempt_count: 1, claim_token: null, claimed_at: null, last_error_code: null, last_error: null,
      attempted_at: '2026-09-14T15:00:00.000Z', failed_at: '2026-09-14T15:00:01.000Z',
      created_at: '2026-09-14T14:59:00.000Z',
    });
    const untouched = sqlite.prepare("SELECT id,state FROM sms_deliveries WHERE id<>'recover' ORDER BY id").all();
    expect(untouched).toEqual(expect.arrayContaining([
      { id: 'accepted', state: 'ACCEPTED' },
      { id: 'cancelled-game', state: 'FAILED' },
      { id: 'deadline-passed', state: 'FAILED' },
      { id: 'delivered', state: 'DELIVERED' },
      { id: 'delivery-expired', state: 'FAILED' },
      { id: 'inactive-offer', state: 'FAILED' },
      { id: 'inactive-plan', state: 'FAILED' },
      { id: 'known-sid', state: 'FAILED' },
      { id: 'other-sender', state: 'FAILED' },
      { id: 'past-game', state: 'FAILED' },
      { id: 'promo', state: 'FAILED' },
      { id: 'sending', state: 'SENDING' },
      { id: 'unknown', state: 'UNKNOWN' },
      { id: 'wrong-code', state: 'FAILED' },
    ]));
  });

  it('asks for identity after a provider-handled START only when no name exists',async()=>{
    const {inbound,member}=setup();
    await inbound('STOP','STOP');

    const response=await inbound('START','START');

    expect(await response.text()).toContain('Reply with your first name + last initial');
    expect(member()).toMatchObject({status:'SUBSCRIBED',display_name:null,awaiting_name:1});
  });

  it.each(['JOIN', 'SUBSCRIBE', 'POKER'])(
    'keeps an opted-out member unsubscribed when they send %s and directs them to START or UNSTOP',
    async (keyword) => {
      const { inbound, member } = setup();
      await inbound('JOIN');
      await inbound('Casey McKay');
      const before = member();
      await inbound('STOP');

      const response = await inbound(keyword);
      const reply = await response.text();

      expect(reply).toContain('text START or UNSTOP');
      expect(member()).toMatchObject({
        display_name: 'Casey McKay',
        public_id: before?.public_id,
        status: 'UNSUBSCRIBED',
        awaiting_name: 0,
      });
    },
  );
});
