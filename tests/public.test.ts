import { describe,it,expect } from 'vitest';
import { publicName } from '../src/lib/public-name';
import { publicRoutes } from '../src/routes/public';
import { createTestDb } from './d1-fixture';
import type { Env } from '../src/types';

describe('public privacy and qualification copy',()=>{
  it('minimizes full names and rejects phone/markup-shaped names',()=>{
    expect(publicName('Jeff Miller')).toBe('Jeff M.');
    expect(publicName('Grant h')).toBe('Grant H.');
    expect(publicName("Zoë O’Connor")).toBe('Zoë O.');
    expect(publicName('+15555550123')).toBe('Player');
    expect(publicName('<script>alert(1)</script>')).toBe('Player');
    expect(publicName(null)).toBe('Player');
  });
  it('never renders full surnames, phone IDs or unrelated business branding',async()=>{
    const {db,sqlite}=createTestDb();
    sqlite.exec(`INSERT INTO members(phone,display_name,public_id,created_at,updated_at) VALUES('+15555550123','Jeff Miller','opaque-id','2026-01-01','2026-01-01');
      INSERT INTO games(id,starts_at,location,created_at) VALUES('g','2026-09-01T23:30:00.000Z','Lounge','2026-01-01');
      INSERT INTO points_ledger VALUES('p','+15555550123','g',5,1,'2026-09-01T23:30:00.000Z');
      INSERT INTO attendance VALUES('a','+15555550123','g','2026-09-01T23:30:00.000Z');`);
    const env={DB:db,PROGRAM_NAME:"Poppa P's",TIMEZONE:'America/Chicago',TWILIO_FROM_NUMBER:'+15555550999'} as Env;
    for(const path of ['/','/player/opaque-id','/game/g','/seasons']){
      const response=await publicRoutes.request(`https://example.test${path}`,{},env);
      expect(response.status).toBe(200);
      const html=await response.text();
      expect(html).not.toContain('Jeff Miller');
      expect(html).not.toContain('+15555550123');
      expect(html.toLowerCase()).not.toContain('skooped');
    }
  });
});
