import { describe, expect, test } from 'vitest';

import type { Quest, ReviewRun } from '@pr-quest/contract/api';
import {
  activeFilterChips,
  agentStateOf,
  countByKind,
  DEFAULT_FILTERS,
  DEFAULT_VIEW,
  filterQuests,
  matchesSearch,
  sortBoardQuests,
  toggleValue,
  viewsEqual,
  type QuestFilters,
  type RunLookup,
} from './questFilters.ts';
import { makeQuest, makeRun } from '../../platform/test-utils/fixtures.ts';

const noRuns: RunLookup = () => undefined;

const ids = (quests: ReadonlyArray<Quest>): Array<number> => quests.map((quest) => quest.number);

function sized(
  number: number,
  lines: number,
  files: number,
  overrides: Partial<Quest> = {},
): Quest {
  return makeQuest({
    number,
    diffStats: { additions: lines, deletions: 0, fileCount: files },
    ...overrides,
  });
}

describe('matchesSearch', () => {
  const quest = makeQuest({
    number: 26944,
    title: 'Add the Fleet Health widget',
    author: { name: 'Ada Lovelace', githubLogin: 'ada' },
    sourceBranch: 'feature/fleet-health',
  });

  test.each([
    ['empty query', ''],
    ['title words in any case', 'fleet HEALTH'],
    ['author name', 'lovelace'],
    ['author login', 'ada'],
    ['branch', 'feature/fleet'],
    ['#number', '#26944'],
    ['repo#number', 'manager#26944'],
    ['repo prefix#number', 'MAN#26944'],
    ['owner/repo#number', 'trackunit/manager#26944'],
    ['bare number inside the label', '2694'],
    ['label text', 'trackunit/manager'],
  ])('matches by %s', (_name, query) => {
    expect(matchesSearch(quest, query)).toBe(true);
  });

  test.each([
    ['another #number', '#2694'],
    ['another repo', 'iris#26944'],
    ['another owner', 'acme/manager#26944'],
    ['a word that appears nowhere', 'dragon'],
    ['one term out of two', 'fleet dragon'],
  ])('does not match %s', (_name, query) => {
    expect(matchesSearch(quest, query)).toBe(false);
  });
});

describe('agentStateOf', () => {
  test.each<[string, ReviewRun | undefined, ReturnType<typeof agentStateOf>]>([
    ['no run', undefined, 'notStarted'],
    ['a queued run', makeRun({ status: 'queued' }), 'running'],
    ['a running run', makeRun({ status: 'running' }), 'running'],
    ['finished and pending', makeRun({ status: 'finished' }), 'lootReady'],
    ['finished and posted', makeRun({ status: 'finished', disposition: 'posted' }), undefined],
    ['an error', makeRun({ status: 'error' }), 'failed'],
    ['a startup failure', makeRun({ status: 'startupFailed' }), 'failed'],
  ])('maps %s', (_name, run, state) => {
    expect(agentStateOf(run)).toBe(state);
  });
});

describe('filterQuests', () => {
  const quests = [
    makeQuest({ number: 1, difficulty: 'Trivial', requestKind: 'direct' }),
    makeQuest({ number: 2, difficulty: 'Normal', requestKind: 'team', isDraft: true }),
    makeQuest({ number: 3, difficulty: 'Hard', requestKind: 'team', approvedByOthers: true }),
    makeQuest({ number: 4, difficulty: 'Boss', requestKind: 'direct' }),
  ];
  const filter = (overrides: Partial<QuestFilters>, runFor: RunLookup = noRuns): Array<number> =>
    ids(filterQuests(quests, { ...DEFAULT_FILTERS, ...overrides }, runFor));

  test('keeps everything with the default filters', () => {
    expect(filter({})).toEqual([1, 2, 3, 4]);
  });

  test('filters by request kind', () => {
    expect(filter({ kind: 'team' })).toEqual([2, 3]);
  });

  test('keeps any of the selected tiers', () => {
    expect(filter({ tiers: ['Trivial', 'Boss'] })).toEqual([1, 4]);
  });

  test('hides drafts and PRs others approved', () => {
    expect(filter({ hideDrafts: true })).toEqual([1, 3, 4]);
    expect(filter({ hideApproved: true })).toEqual([1, 2, 4]);
  });

  test('keeps any of the selected agent states', () => {
    const runs: Record<number, ReviewRun> = {
      1: makeRun({ status: 'running' }),
      2: makeRun({ status: 'finished' }),
      3: makeRun({ status: 'error' }),
    };
    const runFor: RunLookup = (quest) => runs[quest.number];

    expect(filter({ agentStates: ['running', 'failed'] }, runFor)).toEqual([1, 3]);
    expect(filter({ agentStates: ['notStarted'] }, runFor)).toEqual([4]);
    expect(filter({ agentStates: ['lootReady'] }, runFor)).toEqual([2]);
  });

  test('combines filters', () => {
    expect(filter({ kind: 'direct', tiers: ['Boss', 'Normal'], search: '#4' })).toEqual([4]);
  });

  test('counts each request kind with the other filters applied', () => {
    expect(
      countByKind(quests, { ...DEFAULT_FILTERS, kind: 'team', hideDrafts: true }, noRuns),
    ).toEqual({
      all: 3,
      direct: 2,
      team: 1,
    });
  });
});

describe('sortBoardQuests', () => {
  const quests = [
    sized(1, 300, 2, { requestKind: 'team' }),
    sized(2, 10, 1),
    sized(3, 300, 9),
    sized(4, 3000, 40, { requestKind: 'team' }),
  ];

  test('smart keeps direct first, then the longest-waiting', () => {
    const waiting = [
      makeQuest({ number: 1, requestKind: 'team', requestedAt: '2026-10-01T00:00:00Z' }),
      makeQuest({ number: 2, requestedAt: '2026-10-03T00:00:00Z' }),
      makeQuest({ number: 3, requestedAt: '2026-10-02T00:00:00Z', needsAttention: true }),
    ];

    expect(ids(sortBoardQuests(waiting, { mode: 'smart', direction: 'asc' }))).toEqual([3, 2, 1]);
  });

  test('size ascending puts quick wins first, files breaking ties', () => {
    expect(ids(sortBoardQuests(quests, { mode: 'size', direction: 'asc' }))).toEqual([2, 1, 3, 4]);
  });

  test('size descending puts the boss rush first', () => {
    expect(ids(sortBoardQuests(quests, { mode: 'size', direction: 'desc' }))).toEqual([4, 3, 1, 2]);
  });

  test('equal sizes keep the smart order', () => {
    const twins = [sized(1, 5, 1, { requestKind: 'team' }), sized(2, 5, 1)];

    expect(ids(sortBoardQuests(twins, { mode: 'size', direction: 'desc' }))).toEqual([2, 1]);
  });

  describe('by creation time', () => {
    const opened = [
      makeQuest({ number: 1, openedAt: '2026-10-02T00:00:00Z' }),
      makeQuest({ number: 2, openedAt: '2026-10-03T00:00:00Z', requestKind: 'team' }),
      makeQuest({ number: 3, openedAt: '2026-10-01T00:00:00Z' }),
    ];

    test('descending puts the newest PR first', () => {
      expect(ids(sortBoardQuests(opened, { mode: 'created', direction: 'desc' }))).toEqual([
        2, 1, 3,
      ]);
    });

    test('ascending puts the oldest PR first', () => {
      expect(ids(sortBoardQuests(opened, { mode: 'created', direction: 'asc' }))).toEqual([
        3, 1, 2,
      ]);
    });

    test('equal times keep the smart order', () => {
      const twins = [
        makeQuest({ number: 1, openedAt: '2026-10-01T00:00:00Z', requestKind: 'team' }),
        makeQuest({ number: 2, openedAt: '2026-10-01T00:00:00Z' }),
      ];

      expect(ids(sortBoardQuests(twins, { mode: 'created', direction: 'desc' }))).toEqual([2, 1]);
    });
  });

  test('does not mutate its input', () => {
    const input = [...quests];
    sortBoardQuests(input, { mode: 'size', direction: 'desc' });
    expect(ids(input)).toEqual([1, 2, 3, 4]);
  });
});

describe('activeFilterChips', () => {
  test('has no chips for the defaults', () => {
    expect(activeFilterChips(DEFAULT_FILTERS)).toEqual([]);
  });

  test('lists every active filter, each removable on its own', () => {
    const filters: QuestFilters = {
      search: ' fleet ',
      kind: 'team',
      tiers: ['Hard', 'Boss'],
      hideDrafts: true,
      hideApproved: true,
      agentStates: ['lootReady'],
    };

    const chips = activeFilterChips(filters);

    expect(chips.map((chip) => chip.label)).toEqual([
      'Search: “fleet”',
      'Requests: Team',
      'Tier: Hard',
      'Tier: Boss',
      'No drafts',
      'Not approved by others',
      'Agent: Loot ready',
    ]);
    expect(chips.find((chip) => chip.key === 'tier-Hard')?.without).toEqual({
      ...filters,
      tiers: ['Boss'],
    });
    expect(chips.find((chip) => chip.key === 'search')?.without.search).toBe('');
  });
});

describe('toggleValue', () => {
  test('adds and removes while keeping the canonical order', () => {
    const order = ['a', 'b', 'c'];
    expect(toggleValue(['c'], 'a', order)).toEqual(['a', 'c']);
    expect(toggleValue(['a', 'c'], 'c', order)).toEqual(['a']);
  });
});

describe('viewsEqual', () => {
  test('ignores tier order, search padding and the direction of a smart sort', () => {
    const left = {
      filters: { ...DEFAULT_FILTERS, tiers: ['Hard' as const, 'Boss' as const], search: 'x ' },
      sort: { mode: 'smart' as const, direction: 'asc' as const },
    };
    const right = {
      filters: { ...DEFAULT_FILTERS, tiers: ['Boss' as const, 'Hard' as const], search: 'x' },
      sort: { mode: 'smart' as const, direction: 'desc' as const },
    };

    expect(viewsEqual(left, right)).toBe(true);
    expect(
      viewsEqual(DEFAULT_VIEW, { ...DEFAULT_VIEW, sort: { mode: 'size', direction: 'asc' } }),
    ).toBe(false);
  });
});
