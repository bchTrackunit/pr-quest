import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Quest } from '../../../shared/api.ts';
import { FileQuestCache, type CachedQuestState } from './questCache.ts';

const QUEST: Quest = {
  id: 'Trackunit/manager#7',
  title: 'Fix the map',
  repo: { owner: 'Trackunit', name: 'manager' },
  number: 7,
  author: { name: 'Ada', githubLogin: 'ada' },
  sourceBranch: 'fix/map',
  targetBranch: 'main',
  headSha: 'abc',
  status: 'open',
  isDraft: false,
  approvedByOthers: true,
  approvalCount: 2,
  diffStats: { fileCount: 3, additions: 10, deletions: 2 },
  difficulty: 'Trivial',
  requestKind: 'direct',
  requestedTeams: [],
  needsAttention: false,
  githubUrl: 'https://github.com/Trackunit/manager/pull/7',
  openedAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T11:00:00Z',
  requestedAt: '2026-10-29T10:00:00Z',
  source: 'github',
};

const SNAPSHOT = {
  quests: [QUEST],
  fetchedAt: new Date('2026-10-30T14:00:00.000Z'),
  source: 'github' as const,
};

const STATE: CachedQuestState = {
  snapshot: SNAPSHOT,
  backoff: { kind: 'primary', limitedUntil: new Date('2026-10-30T14:01:02.000Z'), attempt: 1 },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileQuestCache', () => {
  test('round-trips the snapshot and backoff through quests.json', async () => {
    await new FileQuestCache(dir).save(STATE);

    await expect(new FileQuestCache(dir).load()).resolves.toEqual(STATE);
    expect((await stat(join(dir, 'quests.json'))).mode & 0o777).toBe(0o600);
  });

  test('loads nothing when the file is missing', async () => {
    await expect(new FileQuestCache(join(dir, 'missing')).load()).resolves.toEqual({});
  });

  test.each([
    ['not JSON', '{oops'],
    ['an unknown version', JSON.stringify({ version: 2 })],
    [
      'a quest missing fields',
      JSON.stringify({
        version: 1,
        snapshot: { quests: [{ id: 'x' }], fetchedAt: '2026-10-30T14:00:00Z', source: 'github' },
      }),
    ],
  ])('ignores %s and warns', async (_name, text) => {
    await writeFile(join(dir, 'quests.json'), text);
    const onWarning = vi.fn();

    await expect(new FileQuestCache(dir, { onWarning }).load()).resolves.toEqual({});
    expect(onWarning).toHaveBeenCalledWith(expect.stringContaining('unreadable'));
  });

  test('drops the server-only activeRunId from saved quests', async () => {
    await new FileQuestCache(dir).save({
      snapshot: { ...SNAPSHOT, quests: [{ ...QUEST, activeRunId: 'run-1' }] },
    });

    const loaded = await new FileQuestCache(dir).load();

    expect(loaded.snapshot?.quests[0]).not.toHaveProperty('activeRunId');
    expect(await readFile(join(dir, 'quests.json'), 'utf8')).toContain('"version":1');
  });
});
