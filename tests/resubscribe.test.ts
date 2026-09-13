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
