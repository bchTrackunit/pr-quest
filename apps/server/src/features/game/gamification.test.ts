import { afterEach, describe, expect, test } from 'vitest';

import type { AchievementId, DifficultyTier, RequestKind } from '@pr-quest/contract/api';
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

/**
 * Local-time dates keep these tests independent of the machine's time zone. November 10th 2026 is
 * a Tuesday, so the default action unlocks no weekend or time-of-day achievement.
 */
const day = (dayOfMonth: number, hour = 12, minute = 0): Date =>
  new Date(2026, 10, dayOfMonth, hour, minute);

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
      { amount: 25, reason: 'achievement', achievementId: 'first-blood' },
    ]);
    expect(update.xpGained).toBe(45);
    expect(update.state.xp).toBe(45);
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

describe('a machine whose TZ names no zone', () => {
  const original = process.env.TZ;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = original;
    }
  });

  test('still rewards actions and counts the streak by the local clock', () => {
    process.env.TZ = '';
    const first = applyReviewAction(initialGameState(), action({ at: day(10) })).state;
    const second = applyReviewAction(first, action({ at: day(11), questId: 'o/r#2' })).state;

    expect(second.streakDays).toBe(2);
    expect(toPlayerState(second, day(11)).streakDays).toBe(2);
  });
});

describe("streaks and days in the player's time zone", () => {
  const utc = (iso: string): Date => new Date(iso);
  const inZone = (timeZone: string, ats: Array<string>, state = initialGameState()): GameState =>
    ats.reduce(
      (current, iso) => applyReviewAction(current, action({ at: utc(iso) }), { timeZone }).state,
      state,
    );

  test('an evening in Los Angeles is one day there, though it crosses midnight in UTC', () => {
    const ats = ['2026-11-10T23:30:00Z', '2026-11-11T00:30:00Z'];

    expect(inZone('UTC', ats)).toMatchObject({ streakDays: 2, lastReviewDate: '2026-11-11' });
    expect(inZone('America/Los_Angeles', ats)).toMatchObject({
      streakDays: 1,
      lastReviewDate: '2026-11-10',
    });
  });

  test('a zone ahead of UTC is already on the next day', () => {
    const state = inZone('Pacific/Kiritimati', ['2026-11-10T11:00:00Z']);

    expect(state.lastReviewDate).toBe('2026-11-11');
  });

  test.each([
    ['spring-forward', ['2026-03-28T11:00:00Z', '2026-03-29T11:00:00Z', '2026-03-30T10:00:00Z']],
    ['fall-back', ['2026-10-24T10:00:00Z', '2026-10-25T11:00:00Z', '2026-10-26T11:00:00Z']],
  ])('a %s day keeps the streak going', (_change, ats) => {
    expect(inZone('Europe/Copenhagen', ats).streakDays).toBe(3);
  });

  test('the streak goes up at local midnight after the 25-hour fall-back day', () => {
    // 22:30Z is 23:30 CET on the 25th; an hour later it is 00:30 on the 26th.
    const state = inZone('Europe/Copenhagen', ['2026-10-25T22:30:00Z', '2026-10-25T23:30:00Z']);

    expect(state).toMatchObject({ streakDays: 2, lastReviewDate: '2026-10-26' });
  });

  test('the player sees the streak until the end of the next day in their zone', () => {
    const state = inZone('America/Los_Angeles', ['2026-11-10T20:00:00Z']);
    // 07:00Z on the 12th is still 23:00 on the 11th in Los Angeles.
    const now = utc('2026-11-12T07:00:00Z');

    expect(toPlayerState(state, now, { timeZone: 'America/Los_Angeles' }).streakDays).toBe(1);
    expect(toPlayerState(state, now, { timeZone: 'UTC' }).streakDays).toBe(0);
  });

  test("the daily ledger starts at the player's midnight", () => {
    const state = inZone('America/Los_Angeles', ['2026-11-11T05:00:00Z']);

    expect(state.ledger.day?.date).toBe('2026-11-10');
  });

  test("Inbox Zero counts an action earlier on the player's day, not the server's", () => {
    const reviewed = inZone('America/Los_Angeles', ['2026-11-10T20:00:00Z']);
    const check = { questCount: 0, at: utc('2026-11-11T02:00:00Z') };

    expect(
      applyQueueChecked(reviewed, check, { timeZone: 'America/Los_Angeles' }).unlocked.map(
        (entry) => entry.id,
      ),
    ).toEqual(['inbox-zero']);
    expect(applyQueueChecked(reviewed, check, { timeZone: 'UTC' }).unlocked).toEqual([]);
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
    const review = { questId: 'o/r#1', provider: 'cursor' as const };
    let state = initialGameState();
    for (let index = 0; index < 9; index++) {
      const update = applyAgentReviewFinished(state, review, day(10));
      expect(update.xpGained).toBe(0);
      state = update.state;
    }

    const tenth = applyAgentReviewFinished(state, review, day(10));

    expect(tenth.unlocked.map((entry) => entry.id)).toEqual(['agent-commander']);
    expect(tenth.grants).toEqual([
      { amount: 50, reason: 'achievement', achievementId: 'agent-commander' },
    ]);
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
      'centurion-bronze',
      'centurion-silver',
      'centurion-gold',
      'team-player',
      'agent-commander',
      'gatekeeper',
      'giant-killer',
      'on-fire',
      'unstoppable',
      'early-bird',
      'night-owl',
      'weekend-warrior',
      'quick-draw',
      'boss-slayer',
      'inbox-zero',
      'clean-sweep',
      'necromancer',
      'the-long-read',
      'eagle-eye',
      'featherweight',
      'second-opinion',
      'explorer',
      'diplomat',
      'bot-wrangler',
      'speedrunner',
      'archaeologist',
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
