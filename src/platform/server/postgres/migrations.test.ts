import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openTestDatabase, type TestDatabase } from '../test-utils/postgres.ts';
import {
  assertSchemaCurrent,
  migrate,
  type Migration,
  MIGRATIONS,
  schemaStatus,
} from './migrations.ts';

let database: TestDatabase;

beforeEach(async () => {
  database = await openTestDatabase({ migrated: false });
});

afterEach(async () => {
  await database.close();
});

const allIds = MIGRATIONS.map((migration) => migration.id);

describe('migrate', () => {
  test('runs every migration on an empty database, then has nothing left to run', async () => {
    const { db } = database;
    expect(await schemaStatus(db)).toEqual({ pending: allIds, unknown: [] });
    await expect(assertSchemaCurrent(db)).rejects.toThrow(/needs migrating/);

    expect(await migrate(db)).toEqual(allIds);
    expect(await migrate(db)).toEqual([]);

    expect(await schemaStatus(db)).toEqual({ pending: [], unknown: [] });
    await expect(assertSchemaCurrent(db)).resolves.toBeUndefined();
  });

  test('creates the user, document and secret tables', async () => {
    const { db } = database;
    await migrate(db);

    await db.query("INSERT INTO users (login) VALUES ('octocat')");
    await db.query(
      "INSERT INTO user_documents (login, kind, body, revision) VALUES ('octocat', 'game', $1::jsonb, 1)",
      [JSON.stringify({ version: 2 })],
    );

    expect((await db.query('SELECT kind, body FROM user_documents')).rows).toEqual([
      { kind: 'game', body: { version: 2 } },
    ]);
    await expect(db.query("INSERT INTO users (login) VALUES ('OctoCat')")).rejects.toThrow();
  });

  test('refuses a database a newer build migrated, before changing anything', async () => {
    const { db } = database;
    await migrate(db);
    await db.query("INSERT INTO schema_migrations (id) VALUES ('9999_from_the_future')");

    await expect(migrate(db)).rejects.toThrow(/newer version of PR Quest.*9999_from_the_future/);
    await expect(assertSchemaCurrent(db)).rejects.toThrow(/newer version/);
  });

  test('a failing migration leaves no trace, so it can run again once fixed', async () => {
    const { db } = database;
    const broken: Array<Migration> = [
      ...MIGRATIONS,
      { id: '0002_broken', statements: ['CREATE TABLE half_done (id int)', 'SELECT nope()'] },
    ];

    await expect(migrate(db, broken)).rejects.toThrow();

    expect(await schemaStatus(db, broken)).toEqual({
      pending: [...allIds, '0002_broken'],
      unknown: [],
    });
    expect((await db.query("SELECT to_regclass('half_done') AS name")).rows).toEqual([
      { name: null },
    ]);
  });

  test('two migrators at once run each migration exactly once', async () => {
    const { db } = database;

    const [first, second] = await Promise.all([migrate(db), migrate(db)]);

    expect([...first, ...second].toSorted()).toEqual(allIds.toSorted());
    expect(await schemaStatus(db)).toEqual({ pending: [], unknown: [] });
  });
});
