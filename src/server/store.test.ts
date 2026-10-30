import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { initialGameState } from './gamification.ts';
import { StateStore, type StoredRun } from './store.ts';

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

describe('StateStore', () => {
  test('starts from an empty game when there is no state file', async () => {
    const store = await StateStore.open(join(dir, 'nested'));

    expect(store.state).toEqual({ version: 1, game: initialGameState(), runs: [] });
  });

  test('persists updates so a reopened store reads them back', async () => {
    const store = await StateStore.open(dir);

    await store.update((state) => ({
      ...state,
      game: { ...state.game, xp: 42 },
      runs: [storedRun],
    }));
    const reopened = await StateStore.open(dir);

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

    const store = await StateStore.open(dir);

    expect(store.state.runs[0]?.run.quest).toEqual(storedRun.run.quest);
  });

  test('writes through a temporary file and leaves only state.json behind', async () => {
    const store = await StateStore.open(dir);

    await store.update((state) => ({ ...state, game: { ...state.game, xp: 1 } }));

    expect(await readdir(dir)).toEqual(['state.json']);
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).toMatchObject({
      game: { xp: 1 },
    });
  });

  test('applies concurrent updates one after another', async () => {
    const store = await StateStore.open(dir);
    const addXp = () =>
      store.update((state) => ({ ...state, game: { ...state.game, xp: state.game.xp + 1 } }));

    await Promise.all([addXp(), addXp(), addXp()]);

    expect(store.state.game.xp).toBe(3);
    expect((await StateStore.open(dir)).state.game.xp).toBe(3);
  });

  test('keeps the previous state when an update throws', async () => {
    const store = await StateStore.open(dir);
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
    const store = await StateStore.open(dir);

    await store.update((state) => state);

    expect(await readdir(dir)).toEqual([]);
  });

  test('moves a corrupt state file aside and starts fresh', async () => {
    await writeFile(join(dir, 'state.json'), '{"version":1,"game":"nope"}');
    const onWarning = vi.fn();

    const store = await StateStore.open(dir, { onWarning });

    expect(store.state.game).toEqual(initialGameState());
    expect((await readdir(dir)).some((name) => name.startsWith('state.json.corrupt-'))).toBe(true);
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('state.json.corrupt-'));
  });
});
