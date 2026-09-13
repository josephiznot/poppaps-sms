import {describe,it,expect} from 'vitest';
import {Hono} from 'hono';
import {admin} from '../src/routes/admin';
import {sessionToken} from '../src/lib/auth';
import {createTestDb} from './d1-fixture';
import type {Env} from '../src/types';

describe('host workflow boundaries',()=>{
  it('requires login and rejects cross-site changes and obsolete tournament actions',async()=>{
    const {db,sqlite}=createTestDb();
    const env={DB:db,ADMIN_PASSWORD:'test-only',TIMEZONE:'America/Chicago'} as Env;
    const app=new Hono<{Bindings:Env}>().route('/admin',admin);
    const cookie=`pp_session=${await sessionToken(env.ADMIN_PASSWORD)}`;
    expect((await app.request('https://example.test/admin/tournament',{},env)).status).toBe(302);
    expect((await app.request('https://example.test/admin/tournament/cancel',{method:'POST',headers:{cookie,Origin:'https://other.test'}},env)).status).toBe(403);
    for(const path of ['/tournament/run','/tournament/backfill','/tournament/reschedule']){
      expect((await app.request(`https://example.test/admin${path}`,{method:'POST',headers:{cookie}},env)).status).toBe(409);
    }
    expect((await app.request('https://example.test/admin/games',{method:'POST',headers:{cookie},body:'date=2026-10-12&is_tournament=1'},env)).status).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM games').get()?.n).toBe(0);
  });
});
