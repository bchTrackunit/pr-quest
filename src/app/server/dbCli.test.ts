import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MasterKeyring } from '../../platform/server/envelope.ts';
import type { Database } from '../../platform/server/postgres/database.ts';
import { MIGRATIONS } from '../../platform/server/postgres/migrations.ts';
import { ensureUser } from '../../platform/server/postgres/documents.ts';
import { PostgresSecretStore } from '../../platform/server/postgres/secrets.ts';
import { openTestDatabase, type TestDatabase } from '../../platform/server/test-utils/postgres.ts';
import { runDbCommand } from './dbCli.ts';

const CONNECTION_STRING = 'postgres://pr_quest:s3cret-password@db.internal:5432/pr_quest';

let database: TestDatabase;
let output: Array<string>;
let connectedTo: Array<string>;

beforeEach(async () => {
  database = await openTestDatabase({ migrated: false });
  output = [];
  connectedTo = [];
});

afterEach(async () => {
  await database.close();
});

/** The CLI closes what it connects to; the test closes the real database itself. */
const run = (args: Array<string>, env: NodeJS.ProcessEnv = { DATABASE_URL: CONNECTION_STRING }) =>
  runDbCommand(args, {
    env,
    connect: (url): Database => {
      connectedTo.push(url);
      return { ...database.db, close: async () => undefined };
    },
    out: (line) => output.push(line),
  });

describe('runDbCommand', () => {
  test('migrate runs the pending migrations, then reports nothing left to run', async () => {
    expect(await run(['migrate'])).toBe(0);
    expect(output).toEqual(MIGRATIONS.map((migration) => `Ran migration ${migration.id}`));
    expect(connectedTo).toEqual([CONNECTION_STRING]);

    output = [];
    expect(await run(['migrate'])).toBe(0);
    expect(output).toEqual(['The database schema is up to date']);
  });

  test('status lists what migrate would run and fails while anything is pending', async () => {
    expect(await run(['status'])).toBe(1);
    expect(output.join('\n')).toMatch(/Pending: 0001_users_documents_secrets/);

    await run(['migrate']);
    output = [];
    expect(await run(['status'])).toBe(0);
    expect(output).toEqual(['The database schema is up to date']);
  });

  test('rewrap-keys rewraps data keys from a previous master key', async () => {
    await run(['migrate']);
    const oldKey = randomBytes(32).toString('base64');
    const octocat = { id: 583231, login: 'octocat' };
    await ensureUser(database.db, octocat);
    const store = await PostgresSecretStore.open(
      database.db,
      octocat,
      MasterKeyring.fromConfig({ current: oldKey }),
    );
    await store.set('cursor', 'key_cursor');
    output = [];

    const env = {
      DATABASE_URL: CONNECTION_STRING,
      PR_QUEST_MASTER_KEY: randomBytes(32).toString('base64'),
      PR_QUEST_PREVIOUS_MASTER_KEYS: oldKey,
    };

    expect(await run(['rewrap-keys'], env)).toBe(0);
    expect(output).toEqual(['Rewrapped 1 data key with the current master key']);
  });

  test('rewrap-keys needs the master key', async () => {
    expect(await run(['rewrap-keys'])).toBe(1);
    expect(output.join('\n')).toMatch(/PR_QUEST_MASTER_KEY is required/);
  });

  test('needs DATABASE_URL', async () => {
    expect(await run(['migrate'], {})).toBe(1);
    expect(output.join('\n')).toMatch(/DATABASE_URL is required/);
    expect(connectedTo).toEqual([]);
  });

  test.each([[[]], [['drop-everything']]])('prints the usage for %j', async (args) => {
    expect(await run(args)).toBe(1);
    expect(output.join('\n')).toMatch(/Usage: .*migrate \| status \| rewrap-keys/);
  });

  test('never prints the connection string, which holds the password', async () => {
    const failing = await runDbCommand(['migrate'], {
      env: { DATABASE_URL: CONNECTION_STRING },
      connect: () => ({
        ...database.db,
        transaction: async () => {
          throw new Error(`password authentication failed`);
        },
        close: async () => undefined,
      }),
      out: (line) => output.push(line),
    });

    expect(failing).toBe(1);
    expect(output.join('\n')).toMatch(/password authentication failed/);
    expect(output.join('\n')).not.toContain('s3cret-password');
  });
});
