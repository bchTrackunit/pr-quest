import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { MasterKeyring } from '../../platform/server/envelope.ts';
import type { Database } from '../../platform/server/postgres/database.ts';
import { openTestDatabase, type TestDatabase } from '../../platform/server/test-utils/postgres.ts';
import { openPostgresStorage } from './postgresStorage.ts';
import { type AppStorage, MACHINE_SCOPE, userScope } from './storage.ts';

const ALICE = { id: 11, login: 'alice' };
const BOB = { id: 12, login: 'bob' };
const OCTOCAT = { id: 583231, login: 'octocat' };

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

  test('opens, with a warning, a database a newer build added to, so a release can roll back', async () => {
    await db.query("INSERT INTO schema_migrations (id) VALUES ('9999_added_table')");
    try {
      await expect(open()).resolves.toBeDefined();
      expect(warnings).toEqual([expect.stringMatching(/9999_added_table/)]);
    } finally {
      await db.query("DELETE FROM schema_migrations WHERE id = '9999_added_table'");
    }
  });
});

describe('settings', () => {
  test("keeps each user's settings, time zone included, apart and saved", async () => {
    const storage = await open();

    await (
      await storage.settings(userScope({ ...ALICE, login: 'Alice' }))
    ).update({
      reviewProvider: 'claude',
      timeZone: 'Europe/Copenhagen',
    });

    const reopened = await open();
    expect((await reopened.settings(userScope(ALICE))).get()).toEqual({
      reviewProvider: 'claude',
      models: {},
      timeZone: 'Europe/Copenhagen',
      timeZoneChangedAt: expect.any(String),
    });
    expect((await reopened.settings(userScope(BOB))).get()).toEqual({
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

    await (
      await storage.secrets(userScope({ ...ALICE, login: 'Alice' }))
    ).set('anthropic', 'sk-ant-alice');

    const reopened = await open();
    expect((await reopened.secrets(userScope(ALICE))).get('anthropic')).toBe('sk-ant-alice');
    expect((await reopened.secrets(userScope(BOB))).get('anthropic')).toBeUndefined();
    const stored = JSON.stringify((await db.query('SELECT sealed FROM user_secrets')).rows);
    expect(stored).not.toContain('sk-ant-alice');
  });

  test('refuses the machine scope, which hosted mode never has', async () => {
    await expect((await open()).secrets(MACHINE_SCOPE)).rejects.toThrow(/per user/);
  });
});

describe('game state', () => {
  test("saves a player's game, which a second server builds on", async () => {
    const first = await (await open()).gameState({ ...OCTOCAT, login: 'OctoCat' });
    await first.update((state) => ({ ...state, game: { ...state.game, xp: 10 } }));

    const second = await (await open()).gameState(OCTOCAT);
    expect(second.state.game.xp).toBe(10);
    await second.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 5 } }));
    await first.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 1 } }));

    expect(first.state.game.xp).toBe(16);
    expect((await db.query('SELECT github_id::int AS id, kind FROM user_documents')).rows).toEqual([
      { id: OCTOCAT.id, kind: 'game' },
    ]);
  });

  test('upgrades version 1 state with the same migration the state file gets', async () => {
    const legacy: unknown = JSON.parse(await readFile(LEGACY_STATE, 'utf8'));
    await db.query('INSERT INTO users (github_id, login) VALUES ($1, $2)', [
      OCTOCAT.id,
      OCTOCAT.login,
    ]);
    await db.query(
      "INSERT INTO user_documents (github_id, kind, body, revision) VALUES ($1, 'game', $2::jsonb, 1)",
      [OCTOCAT.id, JSON.stringify(legacy)],
    );

    const store = await (await open()).gameState(OCTOCAT);

    expect(store.state.version).toBe(2);
    expect(store.state.game.xp).toBe(25);
    expect(store.state.game.ledger).toBeDefined();
  });

  test('refuses a login that is not a GitHub login', async () => {
    await expect((await open()).gameState({ id: 1, login: '../escape' })).rejects.toThrow(
      /Not a GitHub login/,
    );
  });
});

describe('quest cache', () => {
  test("saves a player's quest cache and loads it with its dates", async () => {
    const limitedUntil = new Date('2026-11-01T12:00:00Z');
    await (
      await (await open()).questCache(OCTOCAT)
    ).save({
      backoff: { kind: 'primary', limitedUntil, attempt: 2 },
    });

    expect(
      await (await (await open()).questCache({ ...OCTOCAT, login: 'OctoCat' })).load(),
    ).toEqual({
      backoff: { kind: 'primary', limitedUntil, attempt: 2 },
    });
  });

  test('ignores an unreadable cache, as losing it only costs a refresh', async () => {
    await db.query('INSERT INTO users (github_id, login) VALUES ($1, $2)', [
      OCTOCAT.id,
      OCTOCAT.login,
    ]);
    await db.query(
      "INSERT INTO user_documents (github_id, kind, body, revision) VALUES ($1, 'quests', $2::jsonb, 1)",
      [OCTOCAT.id, JSON.stringify({ version: 7, snapshot: 'from the future' })],
    );

    expect(await (await (await open()).questCache(OCTOCAT)).load()).toEqual({});
    expect(warnings.join('\n')).toMatch(/quest cache was unreadable/);
  });
});

describe('accounts', () => {
  test('a login another account takes over starts empty, and the renamed account keeps its data', async () => {
    const storage = await open();
    await (await storage.secrets(userScope(OCTOCAT))).set('cursor', 'key_cursor_original');
    await (await storage.settings(userScope(OCTOCAT))).update({ reviewProvider: 'claude' });
    const game = await storage.gameState(OCTOCAT);
    await game.update((state) => ({ ...state, game: { ...state.game, xp: 40 } }));
    const newcomer = { id: 9_000_001, login: 'octocat' };

    const other = await open();
    expect((await other.secrets(userScope(newcomer))).get('cursor')).toBeUndefined();
    expect((await other.settings(userScope(newcomer))).get().reviewProvider).toBe('cursor');
    expect((await other.gameState(newcomer)).state.game.xp).toBe(0);
    expect(warnings).toEqual([
      expect.stringMatching(/octocat now belongs to GitHub id 9000001.*GitHub id 583231/),
    ]);

    const renamed = { id: OCTOCAT.id, login: 'octo-renamed' };
    expect((await other.secrets(userScope(renamed))).get('cursor')).toBe('key_cursor_original');
    expect((await other.gameState(renamed)).state.game.xp).toBe(40);
    expect(
      (await db.query('SELECT github_id::int AS id, login FROM users ORDER BY github_id')).rows,
    ).toEqual([
      { id: OCTOCAT.id, login: 'octo-renamed' },
      { id: newcomer.id, login: 'octocat' },
    ]);
  });

  test('records a user once per storage, however many of their stores it opens', async () => {
    const statements: Array<string> = [];
    const counting: Database = {
      query: async (text, params) => {
        statements.push(text);
        return await db.query(text, params);
      },
      transaction: async (work) =>
        await db.transaction(
          async (tx) =>
            await work({
              query: async (text, params) => {
                statements.push(text);
                return await tx.query(text, params);
              },
            }),
        ),
      close: async () => undefined,
    };
    const storage = await openPostgresStorage(counting, { keyring, warn: () => undefined });

    await Promise.all([
      storage.secrets(userScope(OCTOCAT)),
      storage.settings(userScope(OCTOCAT)),
      storage.gameState(OCTOCAT),
      storage.questCache(OCTOCAT),
    ]);

    expect(statements.filter((text) => text.includes('INSERT INTO users'))).toHaveLength(1);
  });
});
