import { describe, it, expect } from 'vitest';
import { createTestDb } from './d1-fixture';
import { replaceGameAttendance, replaceGameResult, standings, champions } from '../src/lib/db';

function setup() {
  const { db, sqlite } = createTestDb();
  sqlite.exec(`INSERT INTO members(phone,display_name,created_at,updated_at) VALUES ('A','Alex B','2026-01-01','2026-01-01'),('B','Brett F','2026-01-01','2026-01-01');
    INSERT INTO games(id,starts_at,location,created_at) VALUES('g','2026-06-01T23:30:00.000Z','Lounge','2026-06-01T00:00:00.000Z');`);
  return { db, sqlite };
}
describe('real database result corrections', () => {
  it('edits attendance without changing recorded points, game type or scoring timestamps',async()=>{
    const {db,sqlite}=setup();
    await replaceGameResult(db,'g',0,[{phone:'A',place:1}],[],true,'2026-06-02');
    const points=sqlite.prepare('SELECT * FROM points_ledger').all();
    const metadata=sqlite.prepare('SELECT scoring_at,results_recorded_at,is_tournament FROM games').get();
    await replaceGameAttendance(db,'g',1,['B']);
    expect(sqlite.prepare('SELECT * FROM points_ledger').all()).toEqual(points);
    expect(sqlite.prepare('SELECT scoring_at,results_recorded_at,is_tournament FROM games').get()).toEqual(metadata);
    expect(sqlite.prepare('SELECT member_phone FROM attendance ORDER BY member_phone').all())
      .toEqual([{member_phone:'A'},{member_phone:'B'}]);
    await expect(replaceGameResult(db,'g',1,[{phone:'B',place:1}],[],true,'2026-06-03')).rejects.toThrow('another window');
    expect(sqlite.prepare('SELECT * FROM points_ledger').all()).toEqual(points);
  });

  it('cannot leave orphan attendance if the game is deleted while saving',async()=>{
    const {db,sqlite}=setup();
    const originalBatch=db.batch.bind(db);
    db.batch=async statements=>{
      sqlite.exec("DELETE FROM games WHERE id='g'");
      return originalBatch(statements);
    };
    await expect(replaceGameAttendance(db,'g',0,['A'])).rejects.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM attendance').get()?.n).toBe(0);
  });

  it('keeps backfills and unchanged edits in the historical season', async () => {
    const {db,sqlite} = setup();
    sqlite.exec(`INSERT INTO seasons VALUES('s','2026-07-01T00:00:00.000Z','{}')`);
    await replaceGameResult(db,'g',0,[{phone:'A',place:1}],[],false,'2026-09-13T00:00:00.000Z');
    expect((await standings(db,'','2026-07-01T00:00:00.000Z'))[0]?.total).toBe(5);
    await replaceGameResult(db,'g',1,[{phone:'A',place:1}],[],false,'2026-09-14T00:00:00.000Z');
    expect(await standings(db,'2026-07-01T00:00:00.000Z')).toEqual([]);
    expect((await standings(db,''))[0]?.total).toBe(5);
  });
  it('rolls back stale writes and cannot double score', async () => {
    const {db} = setup();
    await replaceGameResult(db,'g',0,[{phone:'A',place:1}],[],false,'2026-06-02');
    await expect(replaceGameResult(db,'g',0,[{phone:'B',place:1}],[],false,'2026-06-03')).rejects.toThrow('another window');
    expect((await standings(db,'')).map(r=>[r.phone,r.total])).toEqual([['A',5]]);
  });
  it('cannot leave orphan results if the game is deleted while a form saves',async()=>{
    const {db,sqlite}=setup();
    const originalBatch=db.batch.bind(db);
    db.batch=async statements=>{
      sqlite.exec("DELETE FROM games WHERE id='g'");
      return originalBatch(statements);
    };
    await expect(replaceGameResult(db,'g',0,[{phone:'A',place:1}],[],false,'2026-06-02')).rejects.toThrow();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM points_ledger').get()?.n).toBe(0);
  });
  it('preserves a legacy game effective timestamp and both tied champions', async () => {
    const {db,sqlite}=setup();
    sqlite.exec(`UPDATE games SET scoring_at='2026-06-02T00:00:00.000Z'`);
    await replaceGameResult(db,'g',0,[{phone:'A',place:1},{phone:'B',place:1}],[],true,'2026-09-13');
    expect((await champions(db,'g')).length).toBe(2);
    expect(await standings(db,'')).toEqual([]);
    expect(sqlite.prepare('SELECT awarded_at FROM points_ledger LIMIT 1').get()?.awarded_at).toBe('2026-06-02T00:00:00.000Z');
  });
  it('zero-point tournament rows leave scoring tie order unchanged', async () => {
    const {db,sqlite}=setup();
    sqlite.exec(`INSERT INTO points_ledger VALUES('a','A','g',5,1,'2026-06-01');
    INSERT INTO points_ledger VALUES('b','B','g',5,1,'2026-06-02');
    INSERT INTO points_ledger VALUES('t','A','t',0,1,'2026-06-03');`);
    expect((await standings(db,'')).map(r=>r.phone)).toEqual(['A','B']);
  });
});
