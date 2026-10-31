import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';

import { GameService } from './game.ts';
import { QuestCache } from './questCache.ts';
import { StateStore } from './store.ts';
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
    expect(result).toEqual({ migrated: ['quests.json', 'state.json'] });
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

  test('finishes a migration that copied a file but stopped before backing up the original', async () => {
    const userDir = join(dir, 'users', 'player');
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'state.json'), LEGACY_STATE);
    await writeFile(join(userDir, 'quests.json'), LEGACY_QUESTS);
    await writeFile(join(dir, 'state.json'), LEGACY_STATE);
    await writeFile(join(dir, 'quests.json'), LEGACY_QUESTS);

    const result = await migrateLegacyState(dir, 'player', { now: () => NOW });
    const other = await migrateLegacyState(dir, 'someone-else', { now: () => NOW });

    expect(result.migrated.sort()).toEqual(['quests.json', 'state.json']);
    expect(other).toEqual({ migrated: [] });
    expect((await readdir(dir)).sort()).toEqual([
      'quests.json.migrated-to-player-20261030T140000Z.bak',
      'state.json.migrated-to-player-20261030T140000Z.bak',
      'users',
    ]);
  });

  test('never leaves the quest cache behind for another user once the state has moved', async () => {
    const userDir = join(dir, 'users', 'player');
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'quests.json'), LEGACY_QUESTS);
    await writeFile(join(dir, 'state.json'), LEGACY_STATE);
    await writeFile(join(dir, 'quests.json'), LEGACY_QUESTS);

    await migrateLegacyState(dir, 'player', { now: () => NOW });

    await expect(stat(join(dir, 'quests.json'))).rejects.toThrow();
    expect(await readFile(join(userDir, 'state.json'), 'utf8')).toBe(LEGACY_STATE);
  });
});

describe('migrating a real legacy state folder', () => {
  const FIXTURES = join(import.meta.dirname, 'fixtures', 'legacy');

  beforeEach(async () => {
    await copyFile(join(FIXTURES, 'state.json'), join(dir, 'state.json'));
    await copyFile(join(FIXTURES, 'quests.json'), join(dir, 'quests.json'));
  });

  test("keeps the player's XP, level, counters, achievements and runs exactly", async () => {
    await migrateLegacyState(dir, 'BrianChristensen', { now: () => NOW });

    const userDir = join(dir, 'users', 'brianchristensen');
    const store = await StateStore.open(userDir);
    const player = new GameService(store, { broadcast: () => undefined }).player();
    expect(player).toEqual({
      xp: 25,
      level: 1,
      xpIntoLevel: 25,
      xpForNextLevel: 100,
      streakDays: 1,
      lastReviewDate: '2026-10-30',
      achievements: [{ id: 'first-blood', unlockedAt: '2026-10-30T20:56:08.445Z' }],
      counters: {
        reviewsPosted: 0,
        approvals: 1,
        changesRequested: 0,
        agentReviews: 3,
        teamReviews: 1,
        bossesSlain: 0,
        quickDraws: 0,
      },
    });
    expect(store.state.game.rewardedApprovals).toEqual(['Acme/widgets#99']);
    expect(store.state.runs.map(({ run }) => [run.id, run.provider, run.status])).toEqual(
      (await legacyRuns()).map((run) => [run.id, 'cursor', 'finished']),
    );
    expect((await new QuestCache(userDir).load()).snapshot?.quests).toHaveLength(2);
  });

  test('keeps byte-identical timestamped backups and changes nothing when run again', async () => {
    await migrateLegacyState(dir, 'brianchristensen', { now: () => NOW });
    const userDir = join(dir, 'users', 'brianchristensen');
    const before = await snapshotTree(dir);

    const again = await migrateLegacyState(dir, 'brianchristensen', {
      now: () => new Date('2026-11-01T00:00:00.000Z'),
    });

    expect(again).toEqual({ migrated: [] });
    expect(await snapshotTree(dir)).toEqual(before);
    for (const name of ['state.json', 'quests.json']) {
      const original = await readFile(join(FIXTURES, name), 'utf8');
      expect(await readFile(join(userDir, name), 'utf8')).toBe(original);
      expect(
        await readFile(join(dir, `${name}.migrated-to-brianchristensen-20261030T140000Z.bak`), 'utf8'),
      ).toBe(original);
    }
  });
});

async function legacyRuns(): Promise<Array<{ id: string }>> {
  const text = await readFile(join(import.meta.dirname, 'fixtures', 'legacy', 'state.json'), 'utf8');
  const parsed = z
    .object({ runs: z.array(z.object({ run: z.object({ id: z.string() }) })) })
    .parse(JSON.parse(text));
  return parsed.runs.map(({ run }) => run);
}

/** Every file under `root` with its content, for comparing whole folders. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files[path.slice(root.length)] = await readFile(path, 'utf8');
  }
  return files;
}
