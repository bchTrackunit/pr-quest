import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';

import type { DocumentCodec } from '../documentCodec.ts';
import { openTestDatabase, type TestDatabase } from '../test-utils/postgres.ts';
import type { Database } from './database.ts';
import { ensureUser, PostgresDocument, readDocument, writeDocument } from './documents.ts';

interface Counter {
  count: number;
}

/** Version 2 renamed version 1's `n` to `count`. */
const COUNTER: DocumentCodec<Counter> = {
  version: 2,
  empty: () => ({ count: 0 }),
  decode: (json) => {
    const current = z.object({ version: z.literal(2), count: z.number() }).safeParse(json);
    if (current.success) {
      return { count: current.data.count };
    }
    const legacy = z.object({ version: z.literal(1), n: z.number() }).safeParse(json);
    return legacy.success ? { count: legacy.data.n } : undefined;
  },
  encode: (value) => ({ version: 2, count: value.count }),
};

const OCTOCAT = { id: 583231, login: 'octocat' };
const KEY = { user: OCTOCAT, kind: 'counter' };

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await openTestDatabase();
  db = database.db;
});

beforeEach(async () => {
  await database.reset();
  await ensureUser(db, OCTOCAT);
});

afterAll(async () => {
  await database.close();
});

const open = (options: { onWarning?: (message: string) => void } = {}) =>
  PostgresDocument.open(db, KEY, COUNTER, options);

const increment = (value: Counter): Counter => ({ count: value.count + 1 });

async function storedRow(): Promise<unknown> {
  return (await db.query('SELECT body, revision FROM user_documents')).rows[0];
}

async function putBody(body: unknown, revision = 1): Promise<void> {
  await db.query(
    `INSERT INTO user_documents (github_id, kind, body, revision) VALUES ($1, 'counter', $2::jsonb, $3)
     ON CONFLICT (github_id, kind) DO UPDATE SET body = EXCLUDED.body, revision = EXCLUDED.revision`,
    [OCTOCAT.id, JSON.stringify(body), revision],
  );
}

describe('PostgresDocument', () => {
  test('starts empty, saves an update and reads it back after reopening', async () => {
    const document = await open();
    expect(document.value).toEqual({ count: 0 });

    await document.update(increment);

    expect(document.value).toEqual({ count: 1 });
    expect(await storedRow()).toEqual({ body: { version: 2, count: 1 }, revision: 1 });
    expect((await open()).value).toEqual({ count: 1 });
  });

  test('skips the write when mutate returns the value it was given', async () => {
    const document = await open();

    await document.update((value) => value);

    expect(await storedRow()).toBeUndefined();
  });

  test('applies concurrent updates one at a time, in order', async () => {
    const document = await open();
    const seen: Array<number> = [];

    await Promise.all(
      Array.from({ length: 20 }, () =>
        document.update((value) => {
          seen.push(value.count);
          return increment(value);
        }),
      ),
    );

    expect(seen).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect((await open()).value).toEqual({ count: 20 });
  });

  test("builds on another process's write instead of overwriting it", async () => {
    const first = await open();
    const second = await open();
    await second.update(increment);
    await second.update(increment);

    await first.update(increment);

    expect(first.value).toEqual({ count: 3 });
    expect(await storedRow()).toEqual({ body: { version: 2, count: 3 }, revision: 3 });
  });

  test('loses no write when two processes update at the same time', async () => {
    const [first, second] = await Promise.all([open(), open()]);

    await Promise.all(
      Array.from({ length: 10 }, () => [first.update(increment), second.update(increment)]).flat(),
    );

    expect((await open()).value).toEqual({ count: 20 });
  });

  test('a mutate that throws changes nothing and later updates still run', async () => {
    const document = await open();
    await document.update(increment);

    await expect(
      document.update(() => {
        throw new Error('conflict');
      }),
    ).rejects.toThrow('conflict');
    await document.update(increment);

    expect(document.value).toEqual({ count: 2 });
    expect(await storedRow()).toMatchObject({ revision: 2 });
  });

  test('upgrades an older version on read and saves the new one on the next write', async () => {
    await putBody({ version: 1, n: 5 });

    const document = await open();
    expect(document.value).toEqual({ count: 5 });
    expect(await storedRow()).toMatchObject({ body: { version: 1, n: 5 } });

    await document.update(increment);
    expect(await storedRow()).toEqual({ body: { version: 2, count: 6 }, revision: 2 });
  });

  test('refuses a document a newer build wrote, on open and on update', async () => {
    await putBody({ version: 3, count: 1, more: true });
    await expect(open()).rejects.toThrow(/newer version of PR Quest \(version 3/);

    await putBody({ version: 2, count: 1 });
    const document = await open();
    await putBody({ version: 3, count: 9 }, 2);

    await expect(document.update(increment)).rejects.toThrow(/newer version/);
    expect(await storedRow()).toEqual({ body: { version: 3, count: 9 }, revision: 2 });
  });

  test('sets an unreadable document aside, warns and starts fresh', async () => {
    await putBody({ version: 2, count: 'many' });
    const onWarning = vi.fn();

    const document = await open({ onWarning });

    expect(document.value).toEqual({ count: 0 });
    expect(onWarning).toHaveBeenCalledWith(expect.stringMatching(/user_documents_quarantine/));
    expect((await db.query('SELECT kind, body FROM user_documents_quarantine')).rows).toEqual([
      { kind: 'counter', body: { version: 2, count: 'many' } },
    ]);
    await document.update(increment);
    expect(await storedRow()).toMatchObject({ body: { version: 2, count: 1 } });
  });
});

describe('readDocument and writeDocument', () => {
  test('read what was last written, and nothing before the first write', async () => {
    expect(await readDocument(db, KEY)).toBeUndefined();

    await writeDocument(db, KEY, { version: 1, first: true });
    await writeDocument(db, KEY, { version: 1, second: true });

    expect(await readDocument(db, KEY)).toEqual({ version: 1, second: true });
  });
});

describe('ensureUser', () => {
  const users = async () =>
    (await db.query('SELECT github_id::int AS id, login FROM users ORDER BY github_id')).rows;

  test("follows a renamed account by its id, keeping the account's documents", async () => {
    await (await open()).update(increment);

    expect(await ensureUser(db, { id: OCTOCAT.id, login: 'octo-renamed' })).toEqual({});

    expect(await users()).toEqual([{ id: OCTOCAT.id, login: 'octo-renamed' }]);
    expect((await open()).value).toEqual({ count: 1 });
  });

  test('gives a login another account now holds to that account, which starts empty', async () => {
    await (await open()).update(increment);
    const newcomer = { id: 9_000_001, login: 'octocat' };

    expect(await ensureUser(db, newcomer)).toEqual({ detachedFrom: OCTOCAT.id });

    expect(await users()).toEqual([
      { id: OCTOCAT.id, login: null },
      { id: newcomer.id, login: 'octocat' },
    ]);
    expect(
      (await PostgresDocument.open(db, { user: newcomer, kind: 'counter' }, COUNTER)).value,
    ).toEqual({
      count: 0,
    });
    expect((await open()).value).toEqual({ count: 1 });
  });
});
