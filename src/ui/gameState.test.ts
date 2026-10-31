import { describe, expect, test } from 'vitest';

import {
  activeRateLimit,
  applyServerEvent,
  createInitialGameState,
  groupFindings,
  replaceRuns,
  resetForAccountChange,
  selectRunForQuest,
  sortQuests,
  upsertRun,
} from './gameState.ts';
import {
  makeAchievements,
  makePlayer,
  makeQuest,
  makeResult,
  makeRun,
} from './test-utils/fixtures.ts';

describe('resetForAccountChange', () => {
  test("drops the previous player's game but keeps the player's preferences", () => {
    const state = {
      ...upsertRun(createInitialGameState('granted'), makeRun()),
      quests: [makeQuest()],
      questsLoad: 'ready' as const,
      player: makePlayer(),
      achievements: makeAchievements(),
      toasts: [{ id: 'toast-1', kind: 'error' as const, title: 'Old' }],
      xpPopups: [{ id: 'xp-1', amount: 10, reason: 'approved' as const }],
      questActions: { q: 'review' as const },
      questActionErrors: { q: { message: 'Old error' } },
      openRunId: 'run-1',
      approveQuestId: 'q',
      runsError: 'Old runs error',
      connection: 'open' as const,
      settings: { section: 'github' as const },
      soundEnabled: false,
    };

    expect(resetForAccountChange(state)).toEqual({
      ...createInitialGameState('granted'),
      connection: 'open',
      settings: { section: 'github' },
      soundEnabled: false,
    });
  });
});

describe('replaceRuns', () => {
  test('drops runs missing from the new list', () => {
    const state = upsertRun(createInitialGameState('default'), makeRun({ id: 'old' }));
    const next = replaceRuns(state, [makeRun({ id: 'new' })]);
    expect(Object.keys(next.runs)).toEqual(['new']);
  });
});

describe('selectRunForQuest', () => {
  const quest = makeQuest();

  test('prefers the newest run for the quest', () => {
    const older = makeRun({ id: 'old', startedAt: '2026-10-30T09:00:00.000Z', status: 'error' });
    const newer = makeRun({ id: 'new', startedAt: '2026-10-30T10:00:00.000Z', status: 'running' });
    expect(selectRunForQuest({ old: older, new: newer }, quest)?.id).toBe('new');
  });

  test('uses the server-provided active run when it is the newest', () => {
    const active = makeRun({ id: 'active', startedAt: '2026-10-30T11:00:00.000Z' });
    const other = makeRun({ id: 'other', startedAt: '2026-10-30T10:00:00.000Z' });
    expect(selectRunForQuest({ active, other }, { ...quest, activeRunId: 'active' })?.id).toBe(
      'active',
    );
  });

  test('hides discarded runs and runs for other quests', () => {
    const discarded = makeRun({ id: 'gone', status: 'finished', disposition: 'discarded' });
    const elsewhere = makeRun({ id: 'elsewhere', questId: 'Trackunit/other#1' });
    expect(selectRunForQuest({ gone: discarded, elsewhere }, quest)).toBeUndefined();
  });
});

describe('sortQuests', () => {
  test('puts direct requests first, then needsAttention, then the longest wait', () => {
    const team = makeQuest({ number: 1, requestKind: 'team' });
    const directNew = makeQuest({ number: 2, requestedAt: '2026-10-29T00:00:00.000Z' });
    const directOld = makeQuest({ number: 3, requestedAt: '2026-10-20T00:00:00.000Z' });
    const directUrgent = makeQuest({
      number: 4,
      needsAttention: true,
      requestedAt: '2026-10-30T00:00:00.000Z',
    });
    expect(
      sortQuests([team, directNew, directOld, directUrgent]).map((quest) => quest.number),
    ).toEqual([4, 3, 2, 1]);
  });
});

describe('groupFindings', () => {
  test('groups by severity from critical to nit and drops empty groups', () => {
    const groups = groupFindings(makeResult().findings);
    expect(groups.map((group) => group.severity)).toEqual(['critical', 'minor', 'nit']);
  });
});

describe('applyServerEvent', () => {
  test('questsUpdated replaces the quest list and its source, and marks it ready', () => {
    const state = applyServerEvent(createInitialGameState('default'), {
      type: 'questsUpdated',
      quests: [makeQuest()],
      fetchedAt: '2026-10-30T10:00:00.000Z',
      source: 'github',
      stale: false,
    });
    expect(state.quests).toHaveLength(1);
    expect(state.questSource).toBe('github');
    expect(state.questsLoad).toBe('ready');
  });

  test('questsUpdated carries the rate limit and clears it again', () => {
    const rateLimit = { kind: 'primary' as const, limitedUntil: '2026-10-30T10:05:00.000Z' };
    const base = {
      type: 'questsUpdated' as const,
      quests: [makeQuest()],
      fetchedAt: '2026-10-30T10:00:00.000Z',
      source: 'github' as const,
    };

    const limited = applyServerEvent(createInitialGameState('default'), {
      ...base,
      stale: true,
      rateLimit,
    });
    const cleared = applyServerEvent(limited, { ...base, stale: false });

    expect(limited).toMatchObject({ questsStale: true, questsRateLimit: rateLimit });
    expect(cleared.questsStale).toBe(false);
    expect(cleared.questsRateLimit).toBeUndefined();
  });

  test('achievementUnlocked marks the achievement and adds it to the player', () => {
    const initial = {
      ...createInitialGameState('default'),
      achievements: makeAchievements(),
      player: makePlayer(),
    };
    const teamPlayer = makeAchievements().find((entry) => entry.id === 'team-player');
    if (!teamPlayer) {
      throw new Error('fixture missing');
    }
    const state = applyServerEvent(initial, {
      type: 'achievementUnlocked',
      achievement: teamPlayer,
      unlockedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(state.achievements.find((entry) => entry.id === 'team-player')?.unlockedAt).toBe(
      '2026-10-30T10:00:00.000Z',
    );
    expect(state.player?.achievements.map((entry) => entry.id)).toContain('team-player');
  });

  test('xpGained replaces the player state', () => {
    const player = makePlayer({ xp: 999 });
    const state = applyServerEvent(createInitialGameState('default'), {
      type: 'xpGained',
      eventId: 'xp-1',
      amount: 50,
      reason: 'reviewPosted',
      player,
    });
    expect(state.player).toBe(player);
  });
});

describe('activeRateLimit', () => {
  test('returns the limit until it has passed', () => {
    const rateLimit = { kind: 'secondary' as const, limitedUntil: '2026-10-30T10:05:00.000Z' };
    const until = Date.parse(rateLimit.limitedUntil);

    expect(activeRateLimit(rateLimit, until - 1)).toBe(rateLimit);
    expect(activeRateLimit(rateLimit, until)).toBeUndefined();
    expect(activeRateLimit(undefined, until)).toBeUndefined();
  });
});
