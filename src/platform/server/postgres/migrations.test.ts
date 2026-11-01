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

  test('creates the user, document and secret tables, keyed by GitHub account id', async () => {
    const { db } = database;
    await migrate(db);

    await db.query("INSERT INTO users (github_id, login) VALUES (1, 'octocat')");
    await db.query(
      "INSERT INTO user_documents (github_id, kind, body, revision) VALUES (1, 'game', $1::jsonb, 1)",
      [JSON.stringify({ version: 2 })],
    );

    expect((await db.query('SELECT kind, body FROM user_documents')).rows).toEqual([
      { kind: 'game', body: { version: 2 } },
    ]);
    await expect(
      db.query("INSERT INTO users (github_id, login) VALUES (2, 'OctoCat')"),
    ).rejects.toThrow();
    await expect(
      db.query("INSERT INTO users (github_id, login) VALUES (2, 'octocat')"),
    ).rejects.toThrow();
  });

  test("deleting a user deletes their documents, keys and secrets, but a data key in use can't go alone", async () => {
    const { db } = database;
    await migrate(db);
    await db.query("INSERT INTO users (github_id, login) VALUES (1, 'octocat')");
    await db.query(
      "INSERT INTO user_data_keys (github_id, version, master_key_id, wrapped_key) VALUES (1, 1, 'mk', '\\x00')",
    );
    await db.query(
      "INSERT INTO user_secrets (github_id, name, data_key_version, sealed) VALUES (1, 'cursor', 1, '\\x00')",
    );

    await expect(db.query('DELETE FROM user_data_keys')).rejects.toThrow();
    await db.query('DELETE FROM users WHERE github_id = 1');

    for (const table of ['user_documents', 'user_data_keys', 'user_secrets']) {
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows).toEqual([{ n: 0 }]);
    }
  });

  test('after a rollback, warns about additive migrations from a newer build and runs nothing', async () => {
    const { db } = database;
    const newer: Array<Migration> = [
      ...MIGRATIONS,
      { id: '9999_added_table', statements: ['CREATE TABLE added_later (x int)'] },
    ];
    await migrate(db, newer);
    const warnings: Array<string> = [];
    const olderWithPending: Array<Migration> = [
      ...MIGRATIONS,
      { id: '0500_never_shipped', statements: ['CREATE TABLE never_shipped (x int)'] },
    ];

    expect(await migrate(db, MIGRATIONS, { onWarning: (line) => warnings.push(line) })).toEqual([]);
    expect(await migrate(db, olderWithPending, { onWarning: () => undefined })).toEqual([]);

    expect(warnings).toEqual([
      expect.stringMatching(/newer version of PR Quest.*9999_added_table/),
    ]);
    expect((await db.query("SELECT to_regclass('never_shipped') IS NULL AS absent")).rows).toEqual([
      { absent: true },
    ]);
  });

  test('refuses to migrate a database a newer build changed incompatibly, before changing anything', async () => {
    const { db } = database;
    await migrate(db, [
      ...MIGRATIONS,
      { id: '9999_dropped_column', statements: ['SELECT 1'], breaking: true },
    ]);

    await expect(migrate(db)).rejects.toThrow(/newer version of PR Quest.*9999_dropped_column/);
  });

  test('runs migrations without the pool statement timeout, but with a lock timeout', async () => {
    const { db } = database;
    const probe: Array<Migration> = [
      ...MIGRATIONS,
      {
        id: '0002_probe',
        statements: [
          `CREATE TABLE probe AS SELECT current_setting('statement_timeout') AS statement_timeout,
             current_setting('lock_timeout') AS lock_timeout`,
        ],
      },
    ];
    await db.query("SET statement_timeout = '15s'");

    await migrate(db, probe);

    expect((await db.query('SELECT statement_timeout, lock_timeout FROM probe')).rows).toEqual([
      { statement_timeout: '0', lock_timeout: '1min' },
    ]);
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
