import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** Real SQLite with the D1 binding surface; batch rolls back on any error. */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export function createTestDb(migrate = true): { db: D1Database; sqlite: SqliteDatabase } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(resolve('schema.sql'), 'utf8'));
  if (migrate) {
    // Fresh schema already includes 0005; 0006+ tables may be supplied separately
    // while implementing. CREATE IF NOT EXISTS makes this compatible with final schema.
    for (const file of readdirSync(resolve('migrations')).filter(f => /^000[6-9].*\.sql$/.test(f)))
      sqlite.exec(readFileSync(resolve('migrations', file), 'utf8'));
  }
  class Statement {
    constructor(readonly sql: string, readonly args: any[] = []) {}
    bind(...args: any[]) { return new Statement(this.sql, args); }
    execute() {
      const statement = sqlite.prepare(this.sql);
      const hasRows = statement.columns().length > 0;
      const results = hasRows ? statement.all(...this.args) : [];
      const result = hasRows ? null : statement.run(...this.args);
      return { success: true, results, meta: {changes: Number(result?.changes ?? sqlite.prepare('SELECT changes() AS c').get()?.c ?? 0), last_row_id: Number(result?.lastInsertRowid ?? 0)} };
    }
    async run() { return this.execute(); }
    async all() { return this.execute(); }
    async first(column?: string) {
      const row = sqlite.prepare(this.sql).get(...this.args) ?? null;
      return column ? row?.[column] ?? null : row;
    }
    async raw() { return sqlite.prepare(this.sql).all(...this.args).map(row => Object.values(row)); }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; }
      catch (err) { sqlite.exec('ROLLBACK'); throw err; }
    },
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;
  return { db, sqlite };
}
