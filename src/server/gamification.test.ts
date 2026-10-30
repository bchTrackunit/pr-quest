import { describe, expect, test } from 'vitest';

import type { AchievementId, DifficultyTier, RequestKind } from '../shared/api.ts';
import {
  achievementStatuses,
  applyAgentReviewFinished,
  applyQueueChecked,
  applyReviewAction,
  initialGameState,
  levelProgress,
  localDate,
  toPlayerState,
  xpForLevel,
  type GameState,
  type ReviewAction,
} from './gamification.ts';

/** Local-time dates keep these tests independent of the machine's time zone. */
const day = (dayOfMonth: number, hour = 12, minute = 0): Date =>
  new Date(2026, 9, dayOfMonth, hour, minute);

function action(overrides: Partial<ReviewAction> = {}): ReviewAction {
  return {
    kind: 'reviewPosted',
    questId: 'o/r#1',
    difficulty: 'Trivial',
    requestKind: 'direct',
    requestedAt: day(1, 0).toISOString(),
    at: day(10),
    ...overrides,
  };
}

function applyAll(
  actions: Array<Partial<ReviewAction>>,
  state: GameState = initialGameState(),
): GameState {
  return actions.reduce(
    (current, overrides) => applyReviewAction(current, action(overrides)).state,
    state,
  );
}

const unlockedIds = (state: GameState): Array<AchievementId> =>
  state.achievements.map((entry) => entry.id);

describe('levels', () => {
  test.each([
    [1, 100],
    [2, 283],
    [3, 520],
    [4, 800],
  ])('xpForLevel(%i) is %i', (level, xp) => {
    expect(xpForLevel(level)).toBe(xp);
  });

  test.each([
    [0, { level: 1, xpIntoLevel: 0, xpForNextLevel: 100 }],
    [99, { level: 1, xpIntoLevel: 99, xpForNextLevel: 100 }],
    [100, { level: 2, xpIntoLevel: 0, xpForNextLevel: 283 }],
    [383, { level: 3, xpIntoLevel: 0, xpForNextLevel: 520 }],
    [400, { level: 3, xpIntoLevel: 17, xpForNextLevel: 520 }],
  ])('%i lifetime XP is %o', (xp, progress) => {
    expect(levelProgress(xp)).toEqual(progress);
  });
});

describe('XP for review actions', () => {
  test.each<[ReviewAction['kind'], DifficultyTier, number]>([
    ['reviewPosted', 'Trivial', 20],
    ['reviewPosted', 'Normal', 30],
    ['approved', 'Normal', 23],
    ['approved', 'Hard', 30],
    ['changesRequested', 'Boss', 45],
  ])('%s on a %s quest earns %i base XP', (kind, difficulty, xp) => {
    const { grants } = applyReviewAction(initialGameState(), action({ kind, difficulty }));

    expect(grants[0]).toEqual({ amount: xp, reason: kind, questId: 'o/r#1' });
  });

  test('includes achievement XP in the total gained', () => {
    const update = applyReviewAction(initialGameState(), action());

    expect(update.grants).toEqual([
      { amount: 20, reason: 'reviewPosted', questId: 'o/r#1' },
      { amount: 10, reason: 'achievement' },
    ]);
    expect(update.xpGained).toBe(30);
    expect(update.state.xp).toBe(30);
  });

  test('a second approval of the same quest earns nothing and changes nothing', () => {
    const afterFirst = applyAll([{ kind: 'approved' }]);

    const second = applyReviewAction(afterFirst, action({ kind: 'approved', at: day(11) }));

    expect(second.xpGained).toBe(0);
    expect(second.grants).toEqual([]);
    expect(second.state).toEqual(afterFirst);
  });

  test('posting a review after approving the same quest is still rewarded', () => {
    const afterApprove = applyAll([{ kind: 'approved' }]);

    expect(applyReviewAction(afterApprove, action({ kind: 'reviewPosted' })).xpGained).toBe(20);
  });

  test('counts each action kind', () => {
    const state = applyAll([
      { kind: 'reviewPosted', questId: 'o/r#1' },
      { kind: 'approved', questId: 'o/r#2' },
      { kind: 'changesRequested', questId: 'o/r#3' },
      { kind: 'reviewPosted', questId: 'o/r#4', requestKind: 'team' },
    ]);

    expect(state.counters).toMatchObject({
      reviewsPosted: 2,
      approvals: 1,
      changesRequested: 1,
      teamReviews: 1,
    });
  });
});

describe('streaks', () => {
  test('consecutive local days extend the streak and same-day actions do not', () => {
    const state = applyAll([
      { at: day(10, 9) },
      { at: day(10, 23) },
      { at: day(11, 0, 5) },
      { at: day(12) },
    ]);

    expect(state.streakDays).toBe(3);
    expect(state.lastReviewDate).toBe(localDate(day(12)));
  });

  test('a missed day restarts the streak', () => {
    expect(applyAll([{ at: day(10) }, { at: day(11) }, { at: day(13) }]).streakDays).toBe(1);
  });

  test('the player sees the streak until the day after the last action, then zero', () => {
    const state = applyAll([{ at: day(10) }, { at: day(11) }]);

    expect(toPlayerState(state, day(12)).streakDays).toBe(2);
    expect(toPlayerState(state, day(13)).streakDays).toBe(0);
  });
});

describe('achievements', () => {
  test('First Blood unlocks once, on the first rewarded action', () => {
    const first = applyReviewAction(initialGameState(), action());
    const second = applyReviewAction(first.state, action({ questId: 'o/r#2' }));

    expect(first.unlocked).toEqual([{ id: 'first-blood', unlockedAt: day(10).toISOString() }]);
    expect(second.unlocked).toEqual([]);
  });

  test('Quick Draw needs an approval within an hour of the request', () => {
    const requestedAt = day(10, 9).toISOString();

    expect(unlockedIds(applyAll([{ kind: 'approved', requestedAt, at: day(10, 10) }]))).toContain(
      'quick-draw',
    );
    expect(
      unlockedIds(applyAll([{ kind: 'approved', requestedAt, at: day(10, 10, 1) }])),
    ).not.toContain('quick-draw');
    expect(
      unlockedIds(applyAll([{ kind: 'reviewPosted', requestedAt, at: day(10, 9, 30) }])),
    ).not.toContain('quick-draw');
  });

  test.each<[ReviewAction['kind'], DifficultyTier, boolean]>([
    ['reviewPosted', 'Boss', true],
    ['changesRequested', 'Boss', true],
    ['approved', 'Boss', true],
    ['approved', 'Hard', false],
  ])('Boss Slayer after %s on a %s quest: %s', (kind, difficulty, unlocked) => {
    expect(unlockedIds(applyAll([{ kind, difficulty }])).includes('boss-slayer')).toBe(unlocked);
  });

  test('Team Player needs 10 actions on team requests', () => {
    const teamActions = (count: number, requestKind: RequestKind = 'team') =>
      Array.from({ length: count }, (_, index) => ({ questId: `o/r#${index + 1}`, requestKind }));

    expect(unlockedIds(applyAll(teamActions(9)))).not.toContain('team-player');
    expect(unlockedIds(applyAll(teamActions(10)))).toContain('team-player');
    expect(unlockedIds(applyAll(teamActions(10, 'direct')))).not.toContain('team-player');
  });

  test('On Fire needs a 5-day streak', () => {
    const days = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ at: day(10 + index) }));

    expect(unlockedIds(applyAll(days(4)))).not.toContain('on-fire');
    expect(unlockedIds(applyAll(days(5)))).toContain('on-fire');
  });

  test('Inbox Zero needs an empty queue after an action the same day', () => {
    const reviewedToday = applyAll([{ at: day(10, 9) }]);

    expect(
      applyQueueChecked(reviewedToday, { questCount: 0, at: day(10, 18) }).unlocked.map(
        (u) => u.id,
      ),
    ).toEqual(['inbox-zero']);
    expect(applyQueueChecked(reviewedToday, { questCount: 1, at: day(10, 18) }).unlocked).toEqual(
      [],
    );
    expect(applyQueueChecked(reviewedToday, { questCount: 0, at: day(11, 8) }).unlocked).toEqual(
      [],
    );
    expect(applyQueueChecked(initialGameState(), { questCount: 0, at: day(10) }).unlocked).toEqual(
      [],
    );
  });

  test('returns the same state when a queue check unlocks nothing, so nothing is rewritten', () => {
    const state = applyAll([{ at: day(10, 9) }]);

    expect(applyQueueChecked(state, { questCount: 3, at: day(10, 18) }).state).toBe(state);
  });

  test('Agent Commander unlocks after 10 finished agent reviews, which earn no XP themselves', () => {
    let state = initialGameState();
    for (let index = 0; index < 9; index++) {
      const update = applyAgentReviewFinished(state, day(10));
      expect(update.xpGained).toBe(0);
      state = update.state;
    }

    const tenth = applyAgentReviewFinished(state, day(10));

    expect(tenth.unlocked.map((entry) => entry.id)).toEqual(['agent-commander']);
    expect(tenth.grants).toEqual([{ amount: 40, reason: 'achievement' }]);
    expect(tenth.state.counters.agentReviews).toBe(10);
  });
});

describe('player views', () => {
  test('toPlayerState derives the level from lifetime XP', () => {
    const state = { ...initialGameState(), xp: 150 };

    expect(toPlayerState(state, day(10))).toMatchObject({
      xp: 150,
      level: 2,
      xpIntoLevel: 50,
      xpForNextLevel: 283,
    });
  });

  test('achievementStatuses lists every achievement with progress and unlock time', () => {
    const state = applyAll([
      { requestKind: 'team', questId: 'o/r#1', at: day(10) },
      { requestKind: 'team', questId: 'o/r#2', at: day(11) },
    ]);

    const statuses = achievementStatuses(state, day(11));

    expect(statuses.map((status) => status.id)).toEqual([
      'first-blood',
      'quick-draw',
      'boss-slayer',
      'team-player',
      'inbox-zero',
      'on-fire',
      'agent-commander',
    ]);
    expect(statuses.find((status) => status.id === 'first-blood')).toMatchObject({
      unlockedAt: day(10).toISOString(),
      progress: 1,
      target: 1,
    });
    expect(statuses.find((status) => status.id === 'team-player')).toMatchObject({
      progress: 2,
      target: 10,
    });
    expect(statuses.find((status) => status.id === 'on-fire')).toMatchObject({
      progress: 2,
      target: 5,
    });
    expect(statuses.find((status) => status.id === 'team-player')?.unlockedAt).toBeUndefined();
  });
});
