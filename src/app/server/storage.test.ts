import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
import { createFileStorage, MACHINE_SCOPE, scopeKey, userScope } from './storage.ts';

const OCTOCAT = { id: 583231, login: 'octocat' };
const FIXTURES = join(import.meta.dirname, 'fixtures', 'legacy');

let dir: string;
let logs: Array<string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-storage-'));
  logs = [];
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = (options: { secrets?: SecretStore } = {}) =>
  createFileStorage(dir, {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    ...options,
  });

describe('createFileStorage', () => {
  test('keeps one machine-wide set of keys', async () => {
    const storage = open();

    const machine = await storage.secrets(MACHINE_SCOPE);
    await machine.set('cursor', 'key_machine');

    expect(await storage.secrets(MACHINE_SCOPE)).toBe(machine);
    expect(JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8'))).toEqual({
      version: 1,
      secrets: { cursor: 'key_machine' },
    });
  });

  test('keeps one machine-wide settings file', async () => {
    const storage = open();

    const machine = await storage.settings(MACHINE_SCOPE);
    await machine.update({ reviewProvider: 'claude' });

    expect(await storage.settings(MACHINE_SCOPE)).toBe(machine);
    expect((await open().settings(MACHINE_SCOPE)).get().reviewProvider).toBe('claude');
  });

  test("refuses a user's keys and settings rather than handing over the machine's", async () => {
    const storage = open();

    await expect(storage.secrets(userScope(OCTOCAT))).rejects.toThrow(/per-user/);
    await expect(storage.settings(userScope(OCTOCAT))).rejects.toThrow(/per-user/);
    await expect(stat(join(dir, 'secrets.json'))).rejects.toThrow(/ENOENT/);
  });

  test('uses an injected secret store instead of secrets.json', async () => {
    const saved = new Map<SecretName, string>();
    const injected: SecretStore = {
      get: (name) => saved.get(name),
      set: async (name, value) => {
        saved.set(name, value);
      },
      delete: async (name) => {
        saved.delete(name);
      },
    };
    const storage = open({ secrets: injected });

    await (await storage.secrets(MACHINE_SCOPE)).set('anthropic', 'sk-ant-injected');

    expect(saved.get('anthropic')).toBe('sk-ant-injected');
    await expect(stat(join(dir, 'secrets.json'))).rejects.toThrow(/ENOENT/);
  });

  test("opens a player's game from their own folder, moving the shared legacy state there", async () => {
    await copyFile(join(FIXTURES, 'state.json'), join(dir, 'state.json'));

    const store = await open().gameState({ id: OCTOCAT.id, login: 'OctoCat' });

    expect(store.state.game.xp).toBe(25);
    expect(await readFile(join(dir, 'users', 'octocat', 'state.json'), 'utf8')).toBe(
      await readFile(join(FIXTURES, 'state.json'), 'utf8'),
    );
    expect(logs.join('\n')).toMatch(/Moved state\.json into OctoCat's folder/);
  });

  test("saves a player's quest cache in their own folder", async () => {
    const cache = await open().questCache(OCTOCAT);

    await cache.save({ backoff: { kind: 'primary', limitedUntil: new Date(0), attempt: 1 } });

    expect((await stat(join(dir, 'users', 'octocat', 'quests.json'))).isFile()).toBe(true);
  });

  test('refuses a login that is not a GitHub login', async () => {
    await expect(open().gameState({ id: 1, login: '../escape' })).rejects.toThrow(
      /Not a GitHub login/,
    );
  });
});

describe('userScope', () => {
  test('holds the account id and the lower-cased login, as GitHub logins are case-insensitive', () => {
    expect(userScope({ id: 583231, login: 'OctoCat' })).toEqual({
      kind: 'user',
      user: { id: 583231, login: 'octocat' },
    });
  });

  test('refuses an account id or login GitHub would never send', () => {
    for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => userScope({ id, login: 'octocat' })).toThrow(/Not a GitHub account id/);
    }
    expect(() => userScope({ id: 1, login: '../escape' })).toThrow(/Not a GitHub login/);
  });

  test('keys a scope by account id, so a rename keeps it and a new owner of the login gets another', () => {
    expect(scopeKey(userScope({ id: 7, login: 'old' }))).toBe(
      scopeKey(userScope({ id: 7, login: 'new' })),
    );
    expect(scopeKey(userScope({ id: 7, login: 'same' }))).not.toBe(
      scopeKey(userScope({ id: 8, login: 'same' })),
    );
  });
});
