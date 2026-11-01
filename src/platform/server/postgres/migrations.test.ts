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
    expect(await schemaStatus(db)).toEqual({ pending: allIds, unknown: [], breaking: [] });
    await expect(assertSchemaCurrent(db)).rejects.toThrow(/needs migrating/);

    expect(await migrate(db)).toEqual(allIds);
    expect(await migrate(db)).toEqual([]);

    expect(await schemaStatus(db)).toEqual({ pending: [], unknown: [], breaking: [] });
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

  test('refuses to migrate a database a newer build migrated, before changing anything', async () => {
    const { db } = database;
    await migrate(db);
    await db.query("INSERT INTO schema_migrations (id) VALUES ('9999_from_the_future')");

    await expect(migrate(db)).rejects.toThrow(/newer version of PR Quest.*9999_from_the_future/);
  });

  test('records whether each migration breaks older builds', async () => {
    const { db } = database;
    const withBreaking: Array<Migration> = [
      ...MIGRATIONS,
      { id: '0002_drop_column', statements: ['SELECT 1'], breaking: true },
    ];
    await migrate(db, withBreaking);

    expect(
      (await db.query("SELECT breaking FROM schema_migrations WHERE id = '0002_drop_column'")).rows,
    ).toEqual([{ breaking: true }]);
  });
});

describe('assertSchemaCurrent after a rollback', () => {
  test('starts, with a warning, when the newer build only added to the schema', async () => {
    const { db } = database;
    await migrate(db, [...MIGRATIONS, { id: '0002_added_table', statements: ['SELECT 1'] }]);
    const warnings: Array<string> = [];

    await expect(
      assertSchemaCurrent(db, MIGRATIONS, { onWarning: (message) => warnings.push(message) }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([expect.stringMatching(/0002_added_table/)]);
    expect(await schemaStatus(db)).toEqual({
      pending: [],
      unknown: ['0002_added_table'],
      breaking: [],
    });
  });

  test('refuses when the newer build made a change this build can no longer use', async () => {
    const { db } = database;
    await migrate(db, [
      ...MIGRATIONS,
      { id: '0002_added_table', statements: ['SELECT 1'] },
      { id: '0003_dropped_column', statements: ['SELECT 1'], breaking: true },
    ]);

    await expect(assertSchemaCurrent(db)).rejects.toThrow(
      /newer version of PR Quest.*0003_dropped_column/,
    );
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
      breaking: [],
    });
    expect((await db.query("SELECT to_regclass('half_done') AS name")).rows).toEqual([
      { name: null },
    ]);
  });

  test('two migrators at once run each migration exactly once', async () => {
    const { db } = database;

    const [first, second] = await Promise.all([migrate(db), migrate(db)]);

    expect([...first, ...second].toSorted()).toEqual(allIds.toSorted());
    expect(await schemaStatus(db)).toEqual({ pending: [], unknown: [], breaking: [] });
  });
});
