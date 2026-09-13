import {describe,it,expect} from 'vitest';
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
  it('uses September 7 as the transition cutoff, closes once, and safely replaces a decline',async()=>{
    const {db,sqlite,env}=fixture();
    await tickTournaments(env,new Date('2026-09-13T18:00:00.000Z'));
    const initial=(await listTournamentPlans(db))[0]!;
    expect(initial.planned_starts_at).toBe('2026-09-28T23:30:00.000Z');
    expect(initial.qualification_cutoff).toBe('2026-09-14T15:00:00.000Z');
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
