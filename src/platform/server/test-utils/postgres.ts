import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

import { type Database, poolDatabase, type SqlClient } from '../postgres/database.ts';
import { migrate } from '../postgres/migrations.ts';

/**
 * Set to a `postgres://` URL to run the Postgres tests against a real server instead of PGlite, an
 * in-process Postgres compiled to WebAssembly. Each test file gets its own schema there, dropped at
 * the end. `just test-postgres` starts a throwaway server in Docker and sets it.
 */
export const TEST_DATABASE_URL_VARIABLE = 'PR_QUEST_TEST_DATABASE_URL';

export interface TestDatabase {
  db: Database;
  /** Which engine the tests run on. */
  engine: 'pglite' | 'postgres';
  /** Deletes every user and everything they own, keeping the schema. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** A fresh database for one test file, migrated unless `migrated` is false. */
export async function openTestDatabase(
  options: { migrated?: boolean } = {},
): Promise<TestDatabase> {
  const url = process.env[TEST_DATABASE_URL_VARIABLE];
  const test = url ? await realPostgres(url) : await pglite();
  if (options.migrated ?? true) {
    await migrate(test.db);
  }
  return test;
}

async function realPostgres(url: string): Promise<TestDatabase> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = poolDatabase(
    new Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` }),
  );
  return {
    db,
    engine: 'postgres',
    reset: () => truncateUsers(db),
    close: async () => {
      await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

async function pglite(): Promise<TestDatabase> {
  const engine = new PGlite();
  const client = (target: Pick<PGlite, 'query'>): SqlClient => ({
    query: async (text, params = []) => {
      const result = await target.query(text, [...params]);
      return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
    },
  });
  const db: Database = {
    ...client(engine),
    transaction: (work) => engine.transaction((tx) => work(client(tx))),
    close: () => engine.close(),
  };
  return { db, engine: 'pglite', reset: () => truncateUsers(db), close: () => db.close() };
}

async function truncateUsers(db: Database): Promise<void> {
  const [row] = (await db.query("SELECT to_regclass('users') IS NOT NULL AS present")).rows;
  if (typeof row === 'object' && row !== null && 'present' in row && row.present === true) {
    await db.query('TRUNCATE users CASCADE');
  }
}
