import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'vitest';

import {
  poolConfig,
  poolDatabase,
  type PoolClientLike,
  sqlStateOf,
  transportWarning,
} from './database.ts';

describe('poolConfig', () => {
  test('bounds every wait, so a stuck database fails requests instead of hanging them', () => {
    expect(poolConfig('postgres://db.internal/pr_quest')).toEqual({
      connectionString: 'postgres://db.internal/pr_quest',
      max: 10,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'pr-quest',
    });
  });

  test('takes the pool size', () => {
    expect(poolConfig('postgres://db.internal/pr_quest', { max: 3 }).max).toBe(3);
  });
});

class FakeClient extends EventEmitter implements PoolClientLike {
  public readonly statements: Array<string> = [];
  public released: Array<Error | boolean | undefined> = [];

  public async query(text: string): Promise<{ rows: Array<unknown>; rowCount: number }> {
    this.statements.push(text);
    if (text === 'FAIL') {
      throw new Error('statement failed');
    }
    return { rows: [], rowCount: 0 };
  }

  public release(error?: Error | boolean): void {
    this.released.push(error);
  }
}

function fakePool(client: FakeClient) {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => client,
    end: async () => undefined,
  };
}

describe('poolDatabase transactions', () => {
  test('report a connection error during the transaction instead of crashing the process', async () => {
    const client = new FakeClient();
    const errors: Array<string> = [];
    const db = poolDatabase(fakePool(client), (message) => errors.push(message));

    await db.transaction(async (tx) => {
      client.emit('error', new Error('terminating connection due to administrator command'));
      await tx.query('SELECT 1');
    });

    expect(errors).toEqual([
      'A database connection failed: terminating connection due to administrator command',
    ]);
    expect(client.statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });

  test.each([
    ['commits', async () => undefined],
    [
      'rolls back',
      async (tx: { query: (text: string) => Promise<unknown> }) => {
        await tx.query('FAIL');
      },
    ],
  ])(
    'stop listening for errors once the connection is back in the pool after it %s',
    async (_, work) => {
      const client = new FakeClient();
      const db = poolDatabase(fakePool(client));

      await db.transaction(work).catch(() => undefined);

      expect(client.listenerCount('error')).toBe(0);
      expect(client.released).toHaveLength(1);
    },
  );
});

describe('transportWarning', () => {
  test.each([
    'postgres://u:p@db.example.com/pr_quest?sslmode=require',
    'postgres://u:p@db.example.com/pr_quest?sslmode=verify-full',
    'postgres://u:p@db.example.com/pr_quest?ssl=true',
    'postgres://u:p@pr-quest-db.internal:5432/pr_quest',
    'postgres://u:p@pr-quest-db.flycast:5432/pr_quest',
    'postgres://u:p@localhost/pr_quest',
    'postgres://u:p@127.0.0.1:5432/pr_quest',
    'postgres://u:p@[::1]:5432/pr_quest',
  ])('trusts %s', (url) => {
    expect(transportWarning(url)).toBeUndefined();
  });

  test.each([
    'postgres://u:s3cret@db.example.com/pr_quest',
    'postgres://u:s3cret@db.example.com/pr_quest?sslmode=disable',
  ])('warns about %s, naming the host but not the password', (url) => {
    const warning = transportWarning(url);

    expect(warning).toMatch(/db\.example\.com.*sslmode=require/);
    expect(warning).not.toContain('s3cret');
  });
});

describe('sqlStateOf', () => {
  test("reads a Postgres error's SQLSTATE, and nothing from anything else", () => {
    expect(sqlStateOf(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe('23505');
    for (const other of [new Error('plain'), { code: 23505 }, 'x', null, undefined]) {
      expect(sqlStateOf(other)).toBeUndefined();
    }
  });
});
