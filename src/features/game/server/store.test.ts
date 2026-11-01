import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { GameService } from './game.ts';
import { initialGameState } from './gamification.ts';
import { backfillLedger, FileStateStore, type StoredRun } from './store.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const storedRun: StoredRun = {
  run: {
    id: 'run-1',
    questId: 'o/r#1',
    quest: {
      title: 'T',
      repo: { owner: 'o', name: 'r' },
      number: 1,
      githubUrl: 'https://github.com/o/r/pull/1',
    },
    provider: 'cursor',
    agentId: 'bc-1',
    runId: 'run-abc',
    status: 'finished',
    disposition: 'pending',
    startedAt: '2026-10-30T10:00:00.000Z',
    finishedAt: '2026-10-30T10:05:00.000Z',
    result: {
      summary: 'Fine.',
      verdict: 'comment',
      findings: [{ file: 'a.ts', line: 1, severity: 'nit', body: 'x' }],
    },
  },
  quest: {
    id: 'o/r#1',
    title: 'T',
    repo: { owner: 'o', name: 'r' },
    number: 1,
    githubUrl: 'https://github.com/o/r/pull/1',
    sourceBranch: 'feature',
    targetBranch: 'main',
    headSha: 'abc',
    difficulty: 'Normal',
    requestKind: 'team',
    requestedAt: '2026-10-30T09:00:00.000Z',
  },
};

describe('FileStateStore', () => {
  test('tightens an existing state directory to owner-only access', async () => {
    await chmod(dir, 0o755);

    await FileStateStore.open(dir);

    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test('starts from an empty game when there is no state file', async () => {
    const store = await FileStateStore.open(join(dir, 'nested'));

    expect(store.state).toEqual({ version: 2, game: initialGameState(), runs: [] });
  });

  test('persists updates so a reopened store reads them back', async () => {
    const store = await FileStateStore.open(dir);

    await store.update((state) => ({
      ...state,
      game: { ...state.game, xp: 42 },
      runs: [storedRun],
    }));
    const reopened = await FileStateStore.open(dir);

    expect(reopened.state.game.xp).toBe(42);
    expect(reopened.state.runs).toEqual([storedRun]);
  });

  test('fills in the quest summary for runs saved before runs carried it', async () => {
    const { quest: _summary, ...legacyRun } = storedRun.run;
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        game: initialGameState(),
        runs: [{ run: legacyRun, quest: storedRun.quest }],
      }),
    );

    const store = await FileStateStore.open(dir);

    expect(store.state.runs[0]?.run.quest).toEqual(storedRun.run.quest);
  });

  test('reads runs saved before providers existed as Cursor runs', async () => {
    const { provider: _provider, ...legacyRun } = storedRun.run;
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        game: initialGameState(),
        runs: [{ run: legacyRun, quest: storedRun.quest }],
      }),
    );

    const store = await FileStateStore.open(dir);

    expect(store.state.runs[0]?.run.provider).toBe('cursor');
  });

  test('keeps the omitted files of a Claude result', async () => {
    const claudeRun: StoredRun = {
      ...storedRun,
      run: {
        ...storedRun.run,
        provider: 'claude',
        model: 'claude-sonnet-5-5',
        result: {
          summary: 'Fine.',
          verdict: 'comment',
          findings: [],
          omitted: [{ file: 'yarn.lock', reason: 'lockfile' }],
        },
      },
    };
    const store = await FileStateStore.open(dir);
    await store.update((state) => ({ ...state, runs: [claudeRun] }));

    expect((await FileStateStore.open(dir)).state.runs).toEqual([claudeRun]);
  });

  test('keeps the finding decisions of a run', async () => {
    const decided: StoredRun = {
      ...storedRun,
      run: { ...storedRun.run, findingDecisions: ['rejected'] },
    };
    const store = await FileStateStore.open(dir);
    await store.update((state) => ({ ...state, runs: [decided] }));

    expect((await FileStateStore.open(dir)).state.runs).toEqual([decided]);
  });

  test('drops unreadable finding decisions instead of the whole state file', async () => {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        game: { ...initialGameState(), xp: 42 },
        runs: [{ run: { ...storedRun.run, findingDecisions: ['maybe'] }, quest: storedRun.quest }],
      }),
    );

    const store = await FileStateStore.open(dir);

    expect(store.state.game.xp).toBe(42);
    expect(store.state.runs[0]?.run).toEqual(storedRun.run);
  });

  test('writes through a temporary file and leaves only state.json behind', async () => {
    const store = await FileStateStore.open(dir);

    await store.update((state) => ({ ...state, game: { ...state.game, xp: 1 } }));

    expect(await readdir(dir)).toEqual(['state.json']);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toMatchObject({
      game: { xp: 1 },
    });
  });

  test('applies concurrent updates one after another', async () => {
    const store = await FileStateStore.open(dir);
    const addXp = () =>
      store.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 1 } }));

    await Promise.all([addXp(), addXp(), addXp()]);

    expect(store.state.game.xp).toBe(3);
    expect((await FileStateStore.open(dir)).state.game.xp).toBe(3);
  });

  test('keeps the previous state when an update throws', async () => {
    const store = await FileStateStore.open(dir);
    await store.update((state) => ({ ...state, game: { ...state.game, xp: 5 } }));

    await expect(
      store.update(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await store.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 1 } }));

    expect(store.state.game.xp).toBe(6);
  });

  test('does not write when an update returns the state unchanged', async () => {
    const store = await FileStateStore.open(dir);

    await store.update((state) => state);

    expect(await readdir(dir)).toEqual([]);
  });

  test('moves a corrupt state file aside and starts fresh', async () => {
    await writeFile(join(dir, 'state.json'), '{"version":1,"game":"nope"}');
    const onWarning = vi.fn();

    const store = await FileStateStore.open(dir, { onWarning });

    expect(store.state.game).toEqual(initialGameState());
    expect((await readdir(dir)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('state.json.corrupt-'));
  });

  test('refuses a state file from a newer PR Quest and leaves it in place', async () => {
    const newer = JSON.stringify({ version: 3, game: {}, runs: [] });
    await writeFile(join(dir, 'state.json'), newer);

    await expect(FileStateStore.open(dir)).rejects.toThrow(/newer version of PR Quest/);
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(newer);
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});

describe('migrating version 1 state', () => {
  const FIXTURE = new URL('./fixtures/state-v1.json', import.meta.url);
  /** The fixture's last action was on Saturday 31 October; this is the Sunday after, at noon. */
  const NOW = new Date(2026, 10, 1, 12);

  let original: string;
  let v1: { game: Record<string, unknown>; runs: Array<{ quest: unknown }> };

  beforeEach(async () => {
    original = await readFile(FIXTURE, 'utf8');
    v1 = JSON.parse(original);
    await writeFile(join(dir, 'state.json'), original);
  });

  const openGame = async () => {
    const store = await FileStateStore.open(dir);
    return {
      store,
      game: new GameService(store, { broadcast: () => undefined }, { now: () => NOW }),
    };
  };

  test('keeps XP, level, counters, streak, achievements, approvals and runs exactly', async () => {
    const { store, game } = await openGame();

    expect(game.player()).toEqual({
      xp: 90,
      level: 1,
      xpIntoLevel: 90,
      xpForNextLevel: 100,
      streakDays: 2,
      lastReviewDate: '2026-10-31',
      achievements: [{ id: 'first-blood', unlockedAt: '2026-10-30T20:56:08.445Z' }],
      counters: {
        reviewsPosted: 2,
        approvals: 2,
        changesRequested: 0,
        agentReviews: 5,
        teamReviews: 2,
        bossesSlain: 0,
        quickDraws: 0,
      },
    });
    const { ledger, ...game1 } = store.state.game;
    expect(game1).toEqual(v1.game);
    expect(store.state.runs).toHaveLength(6);
    expect(store.state.runs.map(({ quest }) => quest)).toEqual(v1.runs.map((entry) => entry.quest));
    expect(store.state.runs.map(({ run }) => run.provider)).toEqual([
      'cursor',
      'claude',
      'cursor',
      'claude',
      'cursor',
      'cursor',
    ]);
    expect(ledger).toBeDefined();
  });

  test('backfills the ledger from the approvals and the stored runs', async () => {
    const { store } = await openGame();

    expect(store.state.game.ledger).toEqual({
      repos: ['acme/gizmos', 'acme/widgets', 'acme/gadgets'],
      authors: [],
      botPrs: [],
      changesRequestedPrs: [],
      bossApprovals: 0,
      highSeverityReviews: 1,
      reviewedPrs: ['acme/widgets#100', 'acme/gadgets#7', 'acme/widgets#101', 'acme/widgets#102'],
      runProviders: {
        'acme/widgets#100': ['cursor', 'claude'],
        'acme/gadgets#7': ['cursor'],
        'acme/widgets#101': ['claude'],
        'acme/widgets#102': ['cursor'],
      },
    });
  });

  test('shows progress from the backfill but unlocks nothing until the next game event', async () => {
    const { store, game } = await openGame();
    const status = (id: string) => game.achievements().find((entry) => entry.id === id);

    expect(status('explorer')).toMatchObject({ progress: 3, target: 10 });
    expect(status('centurion-bronze')).toMatchObject({ progress: 4, target: 10 });
    expect(status('agent-commander')).toMatchObject({ progress: 5, target: 10 });
    expect(status('second-opinion')?.unlockedAt).toBeUndefined();
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(original);

    await game.recordQueueChecked(3);

    expect(game.player().achievements.map((entry) => entry.id)).toEqual([
      'first-blood',
      'eagle-eye',
      'second-opinion',
    ]);
    expect(game.player().xp).toBe(90 + 25 + 50);
    expect(store.state.game.achievements[0]).toEqual({
      id: 'first-blood',
      unlockedAt: '2026-10-30T20:56:08.445Z',
    });
  });

  test('writes version 2 on the next change and keeps a copy of the version 1 file', async () => {
    const { game } = await openGame();

    await game.recordQueueChecked(3);

    const written = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    expect(written.version).toBe(2);
    expect(written.game.ledger.highSeverityReviews).toBe(1);
    expect(await readFile(join(dir, 'state.json.v1.bak'), 'utf8')).toBe(original);
    expect((await stat(join(dir, 'state.json.v1.bak'))).mode & 0o777).toBe(0o600);
    const reopened = await FileStateStore.open(dir);
    expect(reopened.state.game.xp).toBe(165);
    expect(reopened.state.game.ledger).toEqual(written.game.ledger);
  });

  test('never overwrites the first version 1 copy', async () => {
    await writeFile(join(dir, 'state.json.v1.bak'), 'first copy');

    await FileStateStore.open(dir);

    expect(await readFile(join(dir, 'state.json.v1.bak'), 'utf8')).toBe('first copy');
  });

  test('counts approvals of Boss PRs whose run kept the tier', () => {
    const boss: StoredRun = {
      ...storedRun,
      quest: { ...storedRun.quest, id: 'o/r#1', difficulty: 'Boss' },
    };

    expect(backfillLedger(['o/r#1', 'o/r#2'], [boss]).bossApprovals).toBe(1);
    expect(backfillLedger(['o/r#2'], [boss]).bossApprovals).toBe(0);
  });
});
