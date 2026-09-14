import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createTestDb} from './d1-fixture';
import {tickTournaments,listTournamentPlans,respondToTournamentOffer,rescheduleTournament} from '../src/lib/tournament';
import {drainOutbox,listDeliveries} from '../src/lib/delivery';
import {tournamentOffers} from '../src/lib/tournament-db';
import type {Env} from '../src/types';

function fixture(){
  const {db,sqlite}=createTestDb();
  sqlite.exec(`INSERT INTO games(id,starts_at,location,created_at,results_recorded_at) VALUES('qualifying','2026-09-07T23:30:00.000Z','Lounge','2026-09-01','2026-09-08');`);
  for(let i=0;i<10;i++){
    const phone=`+15555550${String(i).padStart(3,'0')}`;
    sqlite.prepare('INSERT INTO members(phone,display_name,created_at,updated_at) VALUES(?,?,?,?)').run(phone,`Player${i} Test`,'2026-01-01','2026-01-01');
    sqlite.prepare('INSERT INTO points_ledger(id,member_phone,game_id,points,place,awarded_at) VALUES(?,?,?,?,?,?)').run(`p${i}`,phone,'qualifying',10-i,1,'2026-09-07T23:30:00.000Z');
  }
  sqlite.exec(`INSERT INTO games(id,starts_at,location,created_at,results_recorded_at) VALUES('next-season','2026-09-21T23:30:00.000Z','Lounge','2026-09-01','2026-09-22');
    INSERT INTO points_ledger(id,member_phone,game_id,points,place,awarded_at) VALUES('after-cutoff','+15555550000','next-season',100,1,'2026-09-21T23:30:00.000Z');`);
  const env={DB:db,PROGRAM_NAME:"Poppa P's",TIMEZONE:'America/Chicago',TWILIO_FROM_NUMBER:'+15555550999',REMINDER_LEAD_HOURS:'24',PUBLIC_BASE_URL:'https://example.test'} as Env;
  return {db,sqlite,env};
}
describe('automatic tournament integrated workflow',()=>{
  it('migrates the exact legacy 2026-Q4 scheduled plan once',()=>{
    const {sqlite}=createTestDb(false);
    sqlite.exec(`INSERT INTO games(id,starts_at,location,is_tournament,created_at)
      VALUES('tournament','2026-09-28T23:30:00.000Z','Lounge',1,'2026-09-13T00:00:00.000Z');
      INSERT INTO tournament_plans(
        id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,
        confirmation_deadline,created_at,updated_at
      ) VALUES(
        'plan','2026-Q4','tournament','SCHEDULED','2026-09-28T23:30:00.000Z',
        '2026-09-14T15:00:00.000Z','2026-09-26T23:00:00.000Z',
        '2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'
      );`);
    const migration=readFileSync(resolve('migrations/0007_seven_day_rsvp_deadline.sql'),'utf8');
    sqlite.exec(migration);
    sqlite.exec(migration);
    expect(sqlite.prepare('SELECT confirmation_deadline,version FROM tournament_plans WHERE id=?').get('plan')).toEqual({
      confirmation_deadline:'2026-09-21T15:00:00.000Z',
      version:2,
    });
  });
  it('migrates only an active initial offer if qualification wins the race',()=>{
    const {sqlite}=createTestDb(false);
    sqlite.exec(`INSERT INTO games(id,starts_at,location,is_tournament,created_at)
      VALUES('tournament','2026-09-28T23:30:00.000Z','Lounge',1,'2026-09-13T00:00:00.000Z');
      INSERT INTO tournament_plans(
        id,quarter_key,game_id,status,planned_starts_at,qualification_cutoff,
        confirmation_deadline,season_id,created_at,updated_at
      ) VALUES(
        'plan','2026-Q4','tournament','ACTIVE','2026-09-28T23:30:00.000Z',
        '2026-09-14T15:00:00.000Z','2026-09-26T23:00:00.000Z','season',
        '2026-09-13T00:00:00.000Z','2026-09-13T00:00:00.000Z'
      );
      INSERT INTO tournament_board(
        plan_id,member_phone,rank,score_rank,points,scoring_tiebreak_at,was_subscribed,selected_qualifier
      ) VALUES
        ('plan','+15550000001',1,1,10,'2026-09-07T23:30:00.000Z',1,1),
        ('plan','+15550000009',9,9,2,'2026-09-07T23:30:00.000Z',1,0);
      INSERT INTO tournament_offers(
        id,plan_id,member_phone,board_rank,state,offered_at,response_deadline,updated_at
      ) VALUES
        ('initial','plan','+15550000001',1,'ACTIVE','2026-09-14T15:00:00.000Z','2026-09-26T23:00:00.000Z','2026-09-14T15:00:00.000Z'),
        ('replacement','plan','+15550000009',9,'ACTIVE','2026-09-15T15:00:00.000Z','2026-09-26T23:00:00.000Z','2026-09-15T15:00:00.000Z');
      INSERT INTO sms_deliveries(
        id,logical_key,plan_id,game_id,offer_id,recipient,kind,body,state,created_at,updated_at
      ) VALUES(
        'delivery','initial','plan','tournament','initial','+15550000001','TOURNAMENT_INVITE',
        'Reply CALL by Sat, Sep 26, 6:00 PM CDT to reserve your seat','QUEUED',
        '2026-09-14T15:00:00.000Z','2026-09-14T15:00:00.000Z'
      );`);
    sqlite.exec(readFileSync(resolve('migrations/0007_seven_day_rsvp_deadline.sql'),'utf8'));
    expect(sqlite.prepare('SELECT id,response_deadline FROM tournament_offers ORDER BY id').all()).toEqual([
      {id:'initial',response_deadline:'2026-09-21T15:00:00.000Z'},
      {id:'replacement',response_deadline:'2026-09-26T23:00:00.000Z'},
    ]);
    expect(sqlite.prepare('SELECT body FROM sms_deliveries WHERE id=?').get('delivery')?.body).toContain(
      'Reply CALL by Mon, Sep 21, 10:00 AM CDT',
    );
    sqlite.exec(`UPDATE tournament_plans SET confirmation_deadline='2026-09-26T23:00:00.000Z' WHERE id='plan';
      UPDATE tournament_offers SET response_deadline='2026-09-26T23:00:00.000Z' WHERE id='initial';
      UPDATE sms_deliveries SET state='UNKNOWN',body='Reply CALL by Sat, Sep 26, 6:00 PM CDT' WHERE id='delivery';`);
    sqlite.exec(readFileSync(resolve('migrations/0007_seven_day_rsvp_deadline.sql'),'utf8'));
    expect(sqlite.prepare('SELECT confirmation_deadline FROM tournament_plans WHERE id=?').get('plan')?.confirmation_deadline)
      .toBe('2026-09-26T23:00:00.000Z');
    expect(sqlite.prepare('SELECT response_deadline FROM tournament_offers WHERE id=?').get('initial')?.response_deadline)
      .toBe('2026-09-26T23:00:00.000Z');
  });
  it('uses September 7 as the transition cutoff, closes once, and safely replaces a decline',async()=>{
    const {db,sqlite,env}=fixture();
    await tickTournaments(env,new Date('2026-09-13T18:00:00.000Z'));
    const initial=(await listTournamentPlans(db))[0]!;
    expect(initial.planned_starts_at).toBe('2026-09-28T23:30:00.000Z');
    expect(initial.qualification_cutoff).toBe('2026-09-14T15:00:00.000Z');
    expect(initial.confirmation_deadline).toBe('2026-09-21T15:00:00.000Z');
    await tickTournaments(env,new Date('2026-09-14T15:01:00.000Z'));
    await tickTournaments(env,new Date('2026-09-14T15:02:00.000Z'));
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM seasons').get()?.n).toBe(1);
    expect(sqlite.prepare('SELECT MAX(points) AS n FROM tournament_board').get()?.n).toBe(10);
    expect((await tournamentOffers(db,initial.id)).filter(o=>o.state==='ACTIVE').length).toBe(8);
    let calls=0;
    await drainOutbox(env,new Date('2026-09-14T15:02:00.000Z'),{paceMs:0,clock:()=>new Date('2026-09-14T16:02:00.000Z'),transport:async()=>{calls++;if(calls===3)throw new Error('Connection lost after submit');return {sid:`SM${calls}`,status:'queued'};}});
    expect((await listDeliveries(db,initial.id)).filter(d=>d.state==='UNKNOWN').length).toBe(1);
    await drainOutbox(env,new Date('2026-09-14T16:02:00.000Z'),{paceMs:0,clock:()=>new Date('2026-09-14T16:02:00.000Z'),transport:async()=>{throw new Error('Unexpected repeat send');}});
    expect((await listDeliveries(db,initial.id)).filter(d=>d.state==='ACCEPTED').length).toBe(7);
    const first=(await tournamentOffers(db,initial.id))[0]!;
    await respondToTournamentOffer(env,first.member_phone,'DECLINE',new Date('2026-09-15T15:00:00.000Z'));
    await tickTournaments(env,new Date('2026-09-15T16:00:00.000Z'));
    const offers=await tournamentOffers(db,initial.id);
    expect(offers.filter(o=>o.state==='ACTIVE'||o.state==='CONFIRMED').length).toBe(8);
    expect(offers.find(o=>o.id===first.id)?.state).toBe('REPLACED');
    expect((await respondToTournamentOffer(env,first.member_phone,'CONFIRM',new Date('2026-09-15T17:00:00.000Z'))).outcome).not.toBe('CONFIRMED');
  });
  it('expires initial offers at the seven-day deadline and backfills clear vacancies on that tick',async()=>{
    const {db,env}=fixture();
    await tickTournaments(env,new Date('2026-09-13T18:00:00.000Z'));
    await tickTournaments(env,new Date('2026-09-14T15:00:00.000Z'));
    const plan=(await listTournamentPlans(db))[0]!;
    let offers=await tournamentOffers(db,plan.id);
    expect(offers.filter(o=>o.state==='ACTIVE')).toHaveLength(8);
    expect(new Set(offers.map(o=>o.response_deadline))).toEqual(new Set(['2026-09-21T15:00:00.000Z']));

    await tickTournaments(env,new Date('2026-09-21T14:59:59.999Z'));
    expect((await tournamentOffers(db,plan.id)).filter(o=>o.state==='ACTIVE')).toHaveLength(8);

    const tick=await tickTournaments(env,new Date('2026-09-21T15:00:00.000Z'));
    offers=await tournamentOffers(db,plan.id);
    expect(tick.offersQueued).toBe(2);
    expect(offers.filter(o=>o.state==='ACTIVE').map(o=>o.board_rank)).toEqual([9,10]);
    expect(offers.filter(o=>o.state==='ACTIVE').map(o=>o.response_deadline)).toEqual([
      '2026-09-22T15:00:00.000Z',
      '2026-09-22T15:00:00.000Z',
    ]);
    expect(offers.filter(o=>o.state==='REPLACED')).toHaveLength(2);
    expect(offers.filter(o=>o.state==='EXPIRED')).toHaveLength(6);
  });
  it('rescheduling before invitations preserves the quarterly plan and rejects replay',async()=>{
    const {db,env}=fixture();
    await tickTournaments(env,new Date('2026-09-13T18:00:00.000Z'));
    const p=(await listTournamentPlans(db))[0]!;
    await rescheduleTournament(env,p.id,'2026-10-26',new Date('2026-09-13T18:00:00.000Z'),p.version);
    await expect(rescheduleTournament(env,p.id,'2026-11-09',new Date('2026-09-13T18:00:00.000Z'),p.version)).rejects.toThrow('changed');
    await tickTournaments(env,new Date('2026-09-14T18:00:00.000Z'));
    expect(await listTournamentPlans(db)).toHaveLength(1);
    expect((await listTournamentPlans(db))[0]?.game_id).toBe(p.game_id);
  });
});
