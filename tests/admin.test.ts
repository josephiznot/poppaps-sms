import {afterEach,describe,it,expect,vi} from 'vitest';
import {Hono} from 'hono';
import {admin} from '../src/routes/admin';
import {sessionToken} from '../src/lib/auth';
import {createTestDb} from './d1-fixture';
import type {Env} from '../src/types';

afterEach(()=>{
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('host workflow boundaries',()=>{
  it('requires login and rejects cross-site changes and obsolete tournament actions',async()=>{
    const {db,sqlite}=createTestDb();
    const env={DB:db,ADMIN_PASSWORD:'test-only',TIMEZONE:'America/Chicago'} as Env;
    const app=new Hono<{Bindings:Env}>().route('/admin',admin);
    const cookie=`pp_session=${await sessionToken(env.ADMIN_PASSWORD)}`;
    expect((await app.request('https://example.test/admin/tournament',{},env)).status).toBe(302);
    expect((await app.request('https://example.test/admin/tournament/cancel',{method:'POST',headers:{cookie,Origin:'https://other.test'}},env)).status).toBe(403);
    expect((await app.request('https://example.test/admin/games/g/attendance',{method:'POST'},env)).status).toBe(302);
    expect((await app.request('https://example.test/admin/games/g/attendance',{method:'POST',headers:{cookie,Origin:'https://other.test'}},env)).status).toBe(403);
    for(const path of ['/tournament/run','/tournament/backfill','/tournament/reschedule']){
      expect((await app.request(`https://example.test/admin${path}`,{method:'POST',headers:{cookie}},env)).status).toBe(409);
    }
    expect((await app.request('https://example.test/admin/games',{method:'POST',headers:{cookie},body:'date=2026-10-12&is_tournament=1'},env)).status).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM games').get()?.n).toBe(0);
  });
});

async function attendanceSetup(isTournament = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T22:00:00.000Z'));
  const {db,sqlite}=createTestDb();
  sqlite.exec(`INSERT INTO members(phone,display_name,created_at,updated_at) VALUES
    ('A','Alex B','2026-01-01','2026-01-01'),('B','Brett F','2026-01-01','2026-01-01');
    INSERT INTO games(id,starts_at,location,is_tournament,created_at) VALUES
    ('g','2026-10-26T23:30:00.000Z','Lounge',${isTournament ? 1 : 0},'2026-10-01');`);
  const env={DB:db,ADMIN_PASSWORD:'test-only',TIMEZONE:'America/Chicago'} as Env;
  const app=new Hono<{Bindings:Env}>().route('/admin',admin);
  const cookie=`pp_session=${await sessionToken(env.ADMIN_PASSWORD)}`;
  const get=(path:string)=>app.request(`https://example.test/admin${path}`,{headers:{cookie}},env);
  const post=(path:string,body:string)=>app.request(`https://example.test/admin${path}`,{method:'POST',headers:{cookie},body},env);
  return {sqlite,get,post};
}

describe('attendance before play',()=>{
  it.each([false,true])('saves and prefills early attendance without completing the game or texting (tournament=%s)',async isTournament=>{
    const {sqlite,get,post}=await attendanceSetup(isTournament);
    sqlite.exec("INSERT INTO reward_rules VALUES('r',1,'Test promo',1)");
    const fetch=vi.fn();
    vi.stubGlobal('fetch',fetch);
    expect(await (await get('/games')).text()).toContain('Attendance →');
    const before=await (await get('/games/g')).text();
    expect(before).toContain('Save attendance');
    expect(before).not.toContain('name="place1"');
    const response=await post('/games/g/attendance','result_version=0&attend=A&attend=A');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/admin/games/g?saved=attendance');
    expect(sqlite.prepare('SELECT member_phone,created_at FROM attendance').all()).toEqual([
      {member_phone:'A',created_at:'2026-10-26T23:30:00.000Z'},
    ]);
    expect(sqlite.prepare('SELECT result_version,results_recorded_at,scoring_at,is_tournament FROM games').get())
      .toEqual({result_version:1,results_recorded_at:null,scoring_at:null,is_tournament:isTournament ? 1 : 0});
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM points_ledger').get()?.n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM awarded_rewards').get()?.n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await get(response.headers.get('Location')!.replace('/admin',''))).text())
      .toContain('value="A" checked');
    // An early correction may remove an accidentally checked attendee.
    expect((await post('/games/g/attendance','result_version=1')).status).toBe(303);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attendance').get()?.n).toBe(0);
  });

  it('keeps the result time guard, then saves finishers and pre-recorded attendance when play begins',async()=>{
    const {sqlite,get,post}=await attendanceSetup();
    expect((await post('/games/g/result','result_version=0&place1=A&attend=B')).status).toBe(409);
    expect((await post('/games/g/attendance','result_version=0&attend=B')).status).toBe(303);
    vi.setSystemTime(new Date('2026-10-26T23:30:00.000Z'));
    const page=await (await get('/games/g')).text();
    expect(page).toContain('value="B" checked');
    expect(page).toContain('name="place1"');
    expect(page).toContain('name="result_version" value="1"');
    expect((await post('/games/g/result','result_version=1&place1=A&attend=B')).status).toBe(302);
    expect(sqlite.prepare('SELECT member_phone,points FROM points_ledger').all()).toEqual([{member_phone:'A',points:5}]);
    expect(sqlite.prepare('SELECT member_phone FROM attendance ORDER BY member_phone').all())
      .toEqual([{member_phone:'A'},{member_phone:'B'}]);
    // A stale attendance form must not overwrite the newly recorded result.
    expect((await post('/games/g/attendance','result_version=1')).status).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attendance').get()?.n).toBe(2);
  });

  it('rejects missing versions, unknown players and cancelled games without changing attendance',async()=>{
    const {sqlite,post}=await attendanceSetup();
    for(const body of ['attend=A','result_version=0&attend=missing']) {
      expect((await post('/games/g/attendance',body)).status).toBe(409);
    }
    sqlite.exec('UPDATE games SET cancelled=1');
    expect((await post('/games/g/attendance','result_version=0&attend=A')).status).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attendance').get()?.n).toBe(0);
    expect(sqlite.prepare('SELECT result_version FROM games').get()?.result_version).toBe(0);
  });
});
