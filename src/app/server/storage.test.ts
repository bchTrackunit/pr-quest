import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SecretName, SecretStore } from '../../platform/server/secrets.ts';
import { createFileStorage, MACHINE_SCOPE, userScope } from './storage.ts';

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

    await expect(storage.secrets(userScope('octocat'))).rejects.toThrow(/per-user/);
    await expect(storage.settings(userScope('octocat'))).rejects.toThrow(/per-user/);
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

    const store = await open().gameState('OctoCat');

    expect(store.state.game.xp).toBe(25);
    expect(await readFile(join(dir, 'users', 'octocat', 'state.json'), 'utf8')).toBe(
      await readFile(join(FIXTURES, 'state.json'), 'utf8'),
    );
    expect(logs.join('\n')).toMatch(/Moved state\.json into OctoCat's folder/);
  });

  test("saves a player's quest cache in their own folder", async () => {
    const cache = await open().questCache('octocat');

    await cache.save({ backoff: { kind: 'primary', limitedUntil: new Date(0), attempt: 1 } });

    expect((await stat(join(dir, 'users', 'octocat', 'quests.json'))).isFile()).toBe(true);
  });

  test('refuses a login that is not a GitHub login', async () => {
    await expect(open().gameState('../escape')).rejects.toThrow(/Not a GitHub login/);
  });
});

describe('userScope', () => {
  test('lower-cases the login, as GitHub logins are case-insensitive', () => {
    expect(userScope('OctoCat')).toEqual({ kind: 'user', login: 'octocat' });
  });
});
