import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { MasterKeyring } from '../envelope.ts';
import { openTestDatabase, type TestDatabase } from '../test-utils/postgres.ts';
import { type Database, rowsOf } from './database.ts';
import { PostgresSecretStore, rewrapDataKeys } from './secrets.ts';

const CURSOR_KEY = 'key_cursor_0123456789abcdef';
const ANTHROPIC_KEY = 'sk-ant-api03-secret-value';

let database: TestDatabase;
let db: Database;
let oldKey: string;
let newKey: string;
let keyring: MasterKeyring;

beforeAll(async () => {
  database = await openTestDatabase();
  db = database.db;
});

beforeEach(async () => {
  await database.reset();
  oldKey = randomBytes(32).toString('base64');
  newKey = randomBytes(32).toString('base64');
  keyring = MasterKeyring.fromConfig({ current: oldKey });
});

afterAll(async () => {
  await database.close();
});

const open = (login = 'octocat', ring = keyring) => PostgresSecretStore.open(db, login, ring);

async function allStoredBytes(): Promise<string> {
  const keys = await db.query('SELECT wrapped_key FROM user_data_keys');
  const secrets = await db.query('SELECT sealed FROM user_secrets');
  return JSON.stringify([...keys.rows, ...secrets.rows]);
}

async function masterKeyIds(): Promise<Array<string>> {
  const result = await db.query('SELECT master_key_id FROM user_data_keys ORDER BY login');
  return rowsOf(result, z.object({ master_key_id: z.string() })).map((row) => row.master_key_id);
}

describe('PostgresSecretStore', () => {
  test('saves secrets encrypted and reads them back after reopening', async () => {
    const store = await open();

    await store.set('cursor', CURSOR_KEY);
    await store.set('anthropic', ANTHROPIC_KEY);

    expect(store.get('cursor')).toBe(CURSOR_KEY);
    const reopened = await open();
    expect(reopened.get('cursor')).toBe(CURSOR_KEY);
    expect(reopened.get('anthropic')).toBe(ANTHROPIC_KEY);
    expect(reopened.get('linear')).toBeUndefined();
    const stored = await allStoredBytes();
    for (const secret of [CURSOR_KEY, ANTHROPIC_KEY, 'key_cursor', 'sk-ant']) {
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain(Buffer.from(secret).toString('hex'));
    }
  });

  test('overwrites a secret and forgets a deleted one', async () => {
    const store = await open();
    await store.set('cursor', 'first');

    await store.set('cursor', CURSOR_KEY);
    await store.set('linear', 'lin_api_x');
    await store.delete('linear');

    const reopened = await open();
    expect(reopened.get('cursor')).toBe(CURSOR_KEY);
    expect(reopened.get('linear')).toBeUndefined();
    expect((await db.query('SELECT name FROM user_secrets')).rows).toEqual([{ name: 'cursor' }]);
  });

  test("keeps each user's secrets apart, each under their own data key", async () => {
    await (await open('alice')).set('cursor', 'alice-key');
    await (await open('bob')).set('cursor', 'bob-key');

    expect((await open('alice')).get('cursor')).toBe('alice-key');
    expect((await open('bob')).get('cursor')).toBe('bob-key');
    expect((await open('carol')).get('cursor')).toBeUndefined();
    expect((await db.query('SELECT login FROM user_data_keys ORDER BY login')).rows).toEqual([
      { login: 'alice' },
      { login: 'bob' },
    ]);
  });

  test('a sealed value moved to another secret no longer opens', async () => {
    const store = await open();
    await store.set('cursor', CURSOR_KEY);
    await store.set('anthropic', ANTHROPIC_KEY);
    await db.query(
      `UPDATE user_secrets SET sealed = (SELECT sealed FROM user_secrets WHERE name = 'cursor')
       WHERE name = 'anthropic'`,
    );

    const failure = await open().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/octocat's anthropic key could not be decrypted/);
    expect(String(failure)).not.toContain(CURSOR_KEY);
  });

  test('refuses to open with a master key that did not wrap the data key', async () => {
    await (await open()).set('cursor', CURSOR_KEY);

    await expect(open('octocat', MasterKeyring.fromConfig({ current: newKey }))).rejects.toThrow(
      /isn't configured/,
    );
  });

  test('a rotated keyring still reads old secrets and rewraps the data key on open', async () => {
    await (await open()).set('cursor', CURSOR_KEY);
    const rotated = MasterKeyring.fromConfig({ current: newKey, previous: oldKey });

    expect((await open('octocat', rotated)).get('cursor')).toBe(CURSOR_KEY);

    expect(await masterKeyIds()).toEqual([rotated.currentId]);
    const newOnly = MasterKeyring.fromConfig({ current: newKey });
    expect((await open('octocat', newOnly)).get('cursor')).toBe(CURSOR_KEY);
  });

  test('two servers saving secrets for a new user at once share one data key', async () => {
    const [first, second] = await Promise.all([open(), open()]);

    await Promise.all([first.set('cursor', CURSOR_KEY), second.set('anthropic', ANTHROPIC_KEY)]);

    const reopened = await open();
    expect(reopened.get('cursor')).toBe(CURSOR_KEY);
    expect(reopened.get('anthropic')).toBe(ANTHROPIC_KEY);
    expect((await db.query('SELECT version FROM user_data_keys')).rows).toEqual([{ version: 1 }]);
  });
});

describe('rewrapDataKeys', () => {
  test("rewraps every user's data key under the current master key", async () => {
    await (await open('alice')).set('cursor', 'alice-key');
    await (await open('bob')).set('cursor', 'bob-key');
    const rotated = MasterKeyring.fromConfig({ current: newKey, previous: oldKey });

    expect(await rewrapDataKeys(db, rotated)).toEqual({ rewrapped: 2 });
    expect(await rewrapDataKeys(db, rotated)).toEqual({ rewrapped: 0 });

    const newOnly = MasterKeyring.fromConfig({ current: newKey });
    expect((await open('alice', newOnly)).get('cursor')).toBe('alice-key');
    expect((await open('bob', newOnly)).get('cursor')).toBe('bob-key');
  });
});
