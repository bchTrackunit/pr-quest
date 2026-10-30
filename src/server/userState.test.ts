import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { migrateLegacyState, userStateDir } from './userState.ts';

const LEGACY_STATE = JSON.stringify({ version: 1, game: { xp: 0, counters: { agentReviews: 3 } } });
const LEGACY_QUESTS = JSON.stringify({ version: 1, snapshot: { quests: [] } });
const NOW = new Date('2026-10-30T14:00:00.000Z');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-users-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('userStateDir', () => {
  test('is users/<login>, lower-cased', () => {
    expect(userStateDir(dir, 'Player-One')).toBe(join(dir, 'users', 'player-one'));
  });

  test.each(['', '../x', 'a/b', '-lead', 'x'.repeat(40), 'dot.name'])(
    'rejects the login %j',
    (login) => {
      expect(() => userStateDir(dir, login)).toThrow(/GitHub login/);
    },
  );
});

describe('migrateLegacyState', () => {
  test("moves the shared state and quest cache into the user's folder, byte for byte", async () => {
    await writeFile(join(dir, 'state.json'), LEGACY_STATE, { mode: 0o600 });
    await writeFile(join(dir, 'quests.json'), LEGACY_QUESTS, { mode: 0o600 });

    const result = await migrateLegacyState(dir, 'Player', { now: () => NOW });

    const userDir = join(dir, 'users', 'player');
    expect(result).toEqual({ migrated: ['state.json', 'quests.json'] });
    expect(await readFile(join(userDir, 'state.json'), 'utf8')).toBe(LEGACY_STATE);
    expect(await readFile(join(userDir, 'quests.json'), 'utf8')).toBe(LEGACY_QUESTS);
    expect((await stat(join(userDir, 'state.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(userDir)).mode & 0o777).toBe(0o700);
  });

  test('keeps the originals as backups that cannot be migrated again', async () => {
    await writeFile(join(dir, 'state.json'), LEGACY_STATE);

    await migrateLegacyState(dir, 'player', { now: () => NOW });
    const second = await migrateLegacyState(dir, 'someone-else', { now: () => NOW });

    const backups = (await readdir(dir)).filter((name) => name.endsWith('.bak'));
    expect(backups).toEqual(['state.json.migrated-to-player-20261030T140000Z.bak']);
    expect(await readFile(join(dir, backups[0] ?? ''), 'utf8')).toBe(LEGACY_STATE);
    expect(second).toEqual({ migrated: [] });
    await expect(stat(join(dir, 'users', 'someone-else', 'state.json'))).rejects.toThrow();
  });

  test("never overwrites a user's existing state", async () => {
    const userDir = join(dir, 'users', 'player');
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'state.json'), '{"mine":true}');
    await writeFile(join(dir, 'state.json'), LEGACY_STATE);

    const result = await migrateLegacyState(dir, 'player', { now: () => NOW });

    expect(result).toEqual({ migrated: [] });
    expect(await readFile(join(userDir, 'state.json'), 'utf8')).toBe('{"mine":true}');
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(LEGACY_STATE);
  });

  test('does nothing when there is no shared state', async () => {
    await expect(migrateLegacyState(dir, 'player', { now: () => NOW })).resolves.toEqual({
      migrated: [],
    });
  });
});
