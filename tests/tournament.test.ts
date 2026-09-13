import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import {
  cancelTournament,
  getTournamentSummary,
  rescheduleTournament,
  respondToTournamentOffer,
  tickTournaments,
  tournamentDeadlines,
  tournamentOccurrenceForQuarter,
} from '../src/lib/tournament';
import { createTestDb } from './d1-fixture';

const envFor = (db: D1Database): Env => ({
  DB: db,
  TIMEZONE: 'America/Chicago',
  PROGRAM_NAME: "Poppa P's Poker Night",
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_FROM_NUMBER: '+16156951691',
  PUBLIC_BASE_URL: 'https://example.test',
} as Env);

async function seedScoring(db: D1Database, points = [10, 9, 8, 7, 6, 5, 4, 3]): Promise<string[]> {
  const phones = points.map((_, i) => `+155500000${String(i + 1).padStart(2, '0')}`);
  const at = '2026-03-10T23:30:00.000Z';
  await db.prepare(
    `INSERT INTO games(id,starts_at,location,is_tournament,reminder_sent,cancelled,created_at,scoring_at,results_recorded_at,result_version)
     VALUES('regular-1',?,'Lounge',0,0,0,?,?,?,1)`,
  ).bind(at, at, at, at).run();
  for (let i = 0; i < phones.length; i++) {
    await db.prepare(
      `INSERT INTO members(phone,display_name,status,awaiting_name,created_at,updated_at)
       VALUES(?,?, 'SUBSCRIBED',0,?,?)`,
    ).bind(phones[i], `Player ${i + 1}`, at, at).run();
    await db.prepare(
      'INSERT INTO points_ledger(id,member_phone,game_id,points,place,awarded_at) VALUES(?,?,?,?,?,?)',
    ).bind(`p${i}`, phones[i], 'regular-1', points[i], Math.min(i + 1, 5), at).run();
  }
  return phones;
}

describe('quarterly tournament dates', () => {
  it('uses the first off-week Monday and keeps Chicago DST offsets', () => {
    expect(tournamentOccurrenceForQuarter(2026, 4)).toBe('2026-09-28T23:30:00.000Z');
    expect(tournamentOccurrenceForQuarter(2027, 1)).toBe('2027-01-05T00:30:00.000Z');
    expect(tournamentDeadlines('2026-09-28T23:30:00.000Z')).toEqual({
      qualificationCutoff: '2026-09-14T15:00:00.000Z',
      confirmationDeadline: '2026-09-26T23:00:00.000Z',
    });
  });
});

describe('automatic tournament lifecycle', () => {
  it('freezes one full board, one season and eight durable invitations idempotently', async () => {
    const { db } = createTestDb();
    const env = envFor(db);
    await tickTournaments(env, new Date('2026-03-01T12:00:00.000Z'));
    const phones = await seedScoring(db);
    const closed = await tickTournaments(env, new Date('2026-03-30T16:00:00.000Z'));
    expect(closed.closed).toBe(1);

    const summary = await getTournamentSummary(db, new Date('2026-03-30T16:00:00.000Z'));
    expect(summary.plan?.quarter_key).toBe('2026-Q2');
    expect(summary.plan?.status).toBe('ACTIVE');
    expect(summary.plan?.closed_at).toBe('2026-03-30T15:00:00.000Z');
    expect(summary.board).toHaveLength(8);
    expect(summary.offers).toHaveLength(8);
    expect(summary.deliveries.filter((d) => d.kind === 'TOURNAMENT_INVITE')).toHaveLength(8);
    expect(summary.offers.map((o) => o.member_phone)).toEqual(phones);

    await tickTournaments(env, new Date('2026-03-30T16:01:00.000Z'));
    expect((await getTournamentSummary(db, new Date('2026-03-30T16:01:00.000Z'))).deliveries).toHaveLength(8);
  });

  it('blocks incomplete games and cutoff ties without opening a season', async () => {
    const { db } = createTestDb();
    const env = envFor(db);
    await tickTournaments(env, new Date('2026-03-01T12:00:00.000Z'));
    await db.prepare(
      `INSERT INTO games(id,starts_at,location,is_tournament,reminder_sent,cancelled,created_at,result_version)
       VALUES('missing','2026-03-11T00:30:00.000Z','Lounge',0,0,0,'2026-03-01T00:00:00.000Z',0)`,
    ).run();
    await tickTournaments(env, new Date('2026-03-30T16:00:00.000Z'));
    let summary = await getTournamentSummary(db, new Date('2026-03-30T16:00:00.000Z'));
    expect(summary.plan?.status).toBe('BLOCKED');
    expect(summary.exceptions[0]).toContain('need results');
    expect(summary.plan?.season_id).toBeNull();

    await db.prepare("UPDATE games SET results_recorded_at='2026-03-11T02:00:00.000Z' WHERE id='missing'").run();
    await seedScoring(db, [10, 9, 8, 7, 6, 5, 4, 3, 3]);
    await tickTournaments(env, new Date('2026-03-30T16:02:00.000Z'));
    summary = await getTournamentSummary(db, new Date('2026-03-30T16:02:00.000Z'));
    expect(summary.plan?.status).toBe('BLOCKED');
    expect(summary.plan?.tie_score).toBe(3);
    expect(summary.plan?.season_id).toBeNull();
  });

  it('retires a folded seat before replacement and rejects its later CALL', async () => {
    const { db } = createTestDb();
    const env = envFor(db);
    await tickTournaments(env, new Date('2026-03-01T12:00:00.000Z'));
    const phones = await seedScoring(db, [12, 11, 10, 9, 8, 7, 6, 5, 4]);
    await tickTournaments(env, new Date('2026-03-30T16:00:00.000Z'));
    expect((await respondToTournamentOffer(env, phones[0]!, 'DECLINE', new Date('2026-03-31T12:00:00.000Z'))).outcome).toBe('DECLINED');
    const summary = await getTournamentSummary(db, new Date('2026-03-31T12:00:00.000Z'));
    expect(summary.offers).toHaveLength(9);
    expect(summary.offers.find((o) => o.member_phone === phones[0])?.state).toBe('REPLACED');
    expect(summary.offers.filter((o) => ['ACTIVE', 'CONFIRMED'].includes(o.state))).toHaveLength(8);
    expect((await respondToTournamentOffer(env, phones[0]!, 'CONFIRM', new Date('2026-03-31T12:01:00.000Z'))).outcome).not.toBe('CONFIRMED');
  });

  it('preserves the closed cutoff on reschedule and cancellation is idempotent/version guarded', async () => {
    const { db } = createTestDb();
    const env = envFor(db);
    await tickTournaments(env, new Date('2026-03-01T12:00:00.000Z'));
    await seedScoring(db);
    await tickTournaments(env, new Date('2026-03-30T16:00:00.000Z'));
    let summary = await getTournamentSummary(db, new Date('2026-03-30T16:00:00.000Z'));
    const plan = summary.plan!;
    summary = await rescheduleTournament(env, plan.id, '2026-04-13', new Date('2026-03-24T00:00:00.000Z'), plan.version);
    expect(summary.plan?.qualification_cutoff).toBe(plan.qualification_cutoff);
    await expect(rescheduleTournament(env, plan.id, '2026-04-20', new Date('2026-03-24T00:00:00.000Z'), plan.version)).rejects.toThrow('changed');
    const updated = summary.plan!;
    await cancelTournament(env, updated.id, new Date('2026-03-25T00:00:00.000Z'), updated.version);
    const cancelled = await cancelTournament(env, updated.id, new Date('2026-03-25T00:01:00.000Z'));
    expect(cancelled.plan?.status).toBe('CANCELLED');
  });
});
