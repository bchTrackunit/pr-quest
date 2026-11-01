import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { MasterKeyring } from '../../platform/server/envelope.ts';
import type { Database } from '../../platform/server/postgres/database.ts';
import { openTestDatabase, type TestDatabase } from '../../platform/server/test-utils/postgres.ts';
import { openPostgresStorage } from './postgresStorage.ts';
import { type AppStorage, MACHINE_SCOPE, userScope } from './storage.ts';

const LEGACY_STATE = join(import.meta.dirname, 'fixtures', 'legacy', 'state.json');

let database: TestDatabase;
let db: Database;
let keyring: MasterKeyring;
let warnings: Array<string>;

beforeAll(async () => {
  database = await openTestDatabase();
  db = database.db;
  keyring = MasterKeyring.fromConfig({ current: randomBytes(32).toString('base64') });
});

beforeEach(async () => {
  await database.reset();
  warnings = [];
});

afterAll(async () => {
  await database.close();
});

/** A second call stands in for a second server sharing the database. */
const open = (): Promise<AppStorage> =>
  openPostgresStorage(db, { keyring, warn: (message) => warnings.push(message) });

describe('openPostgresStorage', () => {
  test('refuses a database that has not been migrated', async () => {
    const empty = await openTestDatabase({ migrated: false });
    try {
      await expect(
        openPostgresStorage(empty.db, { keyring, warn: () => undefined }),
      ).rejects.toThrow(/needs migrating/);
    } finally {
      await empty.close();
    }
  });
});

describe('settings', () => {
  test("keeps each user's settings, time zone included, apart and saved", async () => {
    const storage = await open();

    await (
      await storage.settings(userScope('Alice'))
    ).update({
      reviewProvider: 'claude',
      timeZone: 'Europe/Copenhagen',
    });

    const reopened = await open();
    expect((await reopened.settings(userScope('alice'))).get()).toEqual({
      reviewProvider: 'claude',
      models: {},
      timeZone: 'Europe/Copenhagen',
    });
    expect((await reopened.settings(userScope('bob'))).get()).toEqual({
      reviewProvider: 'cursor',
      models: {},
    });
  });

  test('refuses the machine scope, which hosted mode never has', async () => {
    await expect((await open()).settings(MACHINE_SCOPE)).rejects.toThrow(/per user/);
  });
});

describe('secrets', () => {
  test("keeps each user's keys encrypted and apart", async () => {
    const storage = await open();

    await (await storage.secrets(userScope('Alice'))).set('anthropic', 'sk-ant-alice');

    const reopened = await open();
    expect((await reopened.secrets(userScope('alice'))).get('anthropic')).toBe('sk-ant-alice');
    expect((await reopened.secrets(userScope('bob'))).get('anthropic')).toBeUndefined();
    const stored = JSON.stringify((await db.query('SELECT sealed FROM user_secrets')).rows);
    expect(stored).not.toContain('sk-ant-alice');
  });

  test('refuses the machine scope, which hosted mode never has', async () => {
    await expect((await open()).secrets(MACHINE_SCOPE)).rejects.toThrow(/per user/);
  });
});

describe('game state', () => {
  test("saves a player's game, which a second server builds on", async () => {
    const first = await (await open()).gameState('OctoCat');
    await first.update((state) => ({ ...state, game: { ...state.game, xp: 10 } }));

    const second = await (await open()).gameState('octocat');
    expect(second.state.game.xp).toBe(10);
    await second.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 5 } }));
    await first.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 1 } }));

    expect(first.state.game.xp).toBe(16);
    expect((await db.query('SELECT login, kind FROM user_documents')).rows).toEqual([
      { login: 'octocat', kind: 'game' },
    ]);
  });

  test('upgrades version 1 state with the same migration the state file gets', async () => {
    const legacy: unknown = JSON.parse(await readFile(LEGACY_STATE, 'utf8'));
    await db.query("INSERT INTO users (login) VALUES ('octocat')");
    await db.query(
      "INSERT INTO user_documents (login, kind, body, revision) VALUES ('octocat', 'game', $1::jsonb, 1)",
      [JSON.stringify(legacy)],
    );

    const store = await (await open()).gameState('octocat');

    expect(store.state.version).toBe(2);
    expect(store.state.game.xp).toBe(25);
    expect(store.state.game.ledger).toBeDefined();
  });

  test('refuses a login that is not a GitHub login', async () => {
    await expect((await open()).gameState('../escape')).rejects.toThrow(/Not a GitHub login/);
  });
});

describe('quest cache', () => {
  test("saves a player's quest cache and loads it with its dates", async () => {
    const limitedUntil = new Date('2026-11-01T12:00:00Z');
    await (
      await (await open()).questCache('octocat')
    ).save({
      backoff: { kind: 'primary', limitedUntil, attempt: 2 },
    });

    expect(await (await (await open()).questCache('OctoCat')).load()).toEqual({
      backoff: { kind: 'primary', limitedUntil, attempt: 2 },
    });
  });

  test('ignores an unreadable cache, as losing it only costs a refresh', async () => {
    await db.query("INSERT INTO users (login) VALUES ('octocat')");
    await db.query(
      "INSERT INTO user_documents (login, kind, body, revision) VALUES ('octocat', 'quests', $1::jsonb, 1)",
      [JSON.stringify({ version: 7, snapshot: 'from the future' })],
    );

    expect(await (await (await open()).questCache('octocat')).load()).toEqual({});
    expect(warnings.join('\n')).toMatch(/quest cache was unreadable/);
  });
});
