import { describe, expect, test } from 'vitest';

import type { Quest } from '../shared/api.ts';
import { difficultyFor, formatQuestId, parseQuestId, sortQuests } from './quests.ts';

const stats = (lines: number, fileCount = 1) => ({ fileCount, additions: lines, deletions: 0 });

describe('difficultyFor', () => {
  test.each([
    [0, 1, 'Trivial'],
    [49, 1, 'Trivial'],
    [50, 1, 'Normal'],
    [399, 10, 'Normal'],
    [400, 10, 'Hard'],
    [1999, 49, 'Hard'],
    [1999, 50, 'Boss'],
    [2000, 1, 'Boss'],
  ] as const)('%i lines in %i files is %s', (lines, fileCount, tier) => {
    expect(difficultyFor(stats(lines, fileCount))).toBe(tier);
  });

  test('counts additions and deletions together', () => {
    expect(difficultyFor({ fileCount: 1, additions: 30, deletions: 30 })).toBe('Normal');
  });
});

describe('parseQuestId', () => {
  test('splits a full identifier into owner, repo and number', () => {
    expect(parseQuestId('Trackunit/manager#26944')).toEqual({
      repo: { owner: 'Trackunit', name: 'manager' },
      number: 26944,
    });
  });

  test('accepts dots, underscores and dashes in the repo name', () => {
    expect(parseQuestId('my-org/repo.name_x#1')?.repo.name).toBe('repo.name_x');
  });

  test.each([
    '',
    'Trackunit/manager',
    'Trackunit/manager#',
    'Trackunit/manager#0',
    'Trackunit/manager#01',
    'Trackunit/manager#1a',
    'Trackunit/manager#12345678901',
    '-evil/manager#1',
    'Trackunit/-R#1',
    'Trackunit/..#1',
    'Track unit/manager#1',
    'Trackunit/man/ager#1',
    'Trackunit/manager#1 --approve',
  ])('rejects %j', (id) => {
    expect(parseQuestId(id)).toBeUndefined();
  });

  test('round-trips through formatQuestId', () => {
    const parsed = parseQuestId('Trackunit/manager#7');
    expect(parsed && formatQuestId(parsed.repo, parsed.number)).toBe('Trackunit/manager#7');
  });
});

function quest(overrides: Partial<Quest>): Quest {
  return {
    id: 'o/r#1',
    title: 't',
    repo: { owner: 'o', name: 'r' },
    number: 1,
    author: { name: 'a' },
    sourceBranch: 'feature',
    targetBranch: 'main',
    status: 'open',
    diffStats: stats(1),
    difficulty: 'Trivial',
    requestKind: 'team',
    requestedTeams: [],
    needsAttention: false,
    githubUrl: 'https://github.com/o/r/pull/1',
    openedAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    requestedAt: '2026-10-01T00:00:00Z',
    source: 'github',
    ...overrides,
  };
}

describe('sortQuests', () => {
  test('orders direct first, then needsAttention, then oldest requestedAt', () => {
    const quests = [
      quest({ id: 'team-new', requestedAt: '2026-10-03T00:00:00Z' }),
      quest({ id: 'team-attention', needsAttention: true, requestedAt: '2026-10-05T00:00:00Z' }),
      quest({ id: 'direct-new', requestKind: 'direct', requestedAt: '2026-10-04T00:00:00Z' }),
      quest({ id: 'team-old', requestedAt: '2026-10-01T00:00:00Z' }),
      quest({
        id: 'direct-attention',
        requestKind: 'direct',
        needsAttention: true,
        requestedAt: '2026-10-06T00:00:00Z',
      }),
      quest({ id: 'direct-old', requestKind: 'direct', requestedAt: '2026-10-02T00:00:00Z' }),
    ];

    expect(sortQuests(quests).map((item) => item.id)).toEqual([
      'direct-attention',
      'direct-old',
      'direct-new',
      'team-attention',
      'team-old',
      'team-new',
    ]);
  });

  test('does not mutate its input', () => {
    const quests = [
      quest({ id: 'b', requestKind: 'team' }),
      quest({ id: 'a', requestKind: 'direct' }),
    ];

    sortQuests(quests);

    expect(quests.map((item) => item.id)).toEqual(['b', 'a']);
  });
});
