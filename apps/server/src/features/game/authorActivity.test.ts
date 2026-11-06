import { describe, expect, test } from 'vitest';

import type { DifficultyTier } from '@pr-quest/contract/api';
import { applyAuthorActivity } from './authorActivity.ts';
import type { AuthorActivity, AuthorObservation } from './authorLedger.ts';
import {
  currentStreak,
  initialGameState,
  type GameState,
  type GameUpdate,
} from './gamification.ts';

/** Local times in November 2026, so the tests don't depend on the machine's time zone. */
const at = (dayOfMonth: number, hour = 12): Date => new Date(2026, 10, dayOfMonth, hour);
const iso = (dayOfMonth: number, hour = 12): string => at(dayOfMonth, hour).toISOString();

const PR = 'o/r#1';
const OTHER = 'o/r#2';

const merged = (
  overrides: Partial<Extract<AuthorObservation, { kind: 'merged' }>> = {},
): AuthorObservation => ({
  kind: 'merged',
  prId: PR,
  mergedAt: iso(10),
  tier: 'Hard',
  resolvedThreads: 0,
  everChangesRequested: false,
  createdAt: iso(9),
  ...overrides,
});

const approved = (submittedAt: string, tier: DifficultyTier = 'Hard', prId = PR) =>
  ({ kind: 'approved', prId, submittedAt, tier }) satisfies AuthorObservation;

const thread = (threadId: string, prCreatedAt = iso(9), tier: DifficultyTier = 'Hard', prId = PR) =>
  ({ kind: 'threadResolved', prId, threadId, tier, prCreatedAt }) satisfies AuthorObservation;

const activity = (
  observations: Array<AuthorObservation>,
  extra: Partial<AuthorActivity> = {},
): AuthorActivity => ({
  observations,
  readPrs: [...new Set(observations.map((observation) => observation.prId))],
  ...extra,
});

/** XP from author events alone, without achievement rewards. */
const authorXpOf = (update: GameUpdate): number =>
  update.grants
    .filter((grant) => grant.reason !== 'achievement')
    .reduce((sum, grant) => sum + grant.amount, 0);

const authorGrants = (update: GameUpdate) =>
  update.grants.filter((grant) => grant.reason !== 'achievement');

/** A state whose first sync, with nothing to read, happened on November 1st. */
function tracked(): GameState {
  return applyAuthorActivity(initialGameState(), activity([]), at(1)).state;
}

describe('applyAuthorActivity', () => {
  test('the first sync starts tracking and pays nothing', () => {
    const update = applyAuthorActivity(initialGameState(), activity([]), at(1));

    expect(update.state.author.trackingSince).toBe(iso(1));
    expect(update.xpGained).toBe(0);
  });

  test('tracking starts when the first read started, so a merge during the read still pays', () => {
    const first = applyAuthorActivity(
      initialGameState(),
      activity([], { readAt: iso(1, 9) }),
      at(1, 10),
    );
    const next = applyAuthorActivity(
      first.state,
      activity([merged({ mergedAt: iso(1, 9) })]),
      at(1, 11),
    );

    expect(first.state.author.trackingSince).toBe(iso(1, 9));
    expect(authorXpOf(next)).toBe(20);
  });

  test('a merge, an approval and a thread each pay once, with the tier multiplier', () => {
    const observations = [
      merged({ tier: 'Trivial' }),
      approved(iso(9), 'Trivial'),
      thread('t1', iso(9), 'Trivial'),
    ];
    const first = applyAuthorActivity(tracked(), activity(observations), at(10));
    const second = applyAuthorActivity(first.state, activity(observations), at(11));

    expect(authorGrants(first)).toEqual([
      { amount: 40, reason: 'prMerged', questId: PR },
      { amount: 20, reason: 'prApproved', questId: PR },
      { amount: 6, reason: 'threadResolved', questId: PR },
    ]);
    expect(first.state.xp).toBe(66 + 25);
    expect(second.xpGained).toBe(0);
    expect(second.state.xp).toBe(first.state.xp);
  });

  test.each<[DifficultyTier, number]>([
    ['Trivial', 40],
    ['Normal', 30],
    ['Hard', 20],
    ['Boss', 10],
  ])('a %s merge pays %i XP', (tier, xp) => {
    expect(authorXpOf(applyAuthorActivity(tracked(), activity([merged({ tier })]), at(10)))).toBe(
      xp,
    );
  });

  test('at most five threads pay per PR', () => {
    const threads = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => thread(id));
    const update = applyAuthorActivity(tracked(), activity(threads), at(10));

    expect(update.grants).toHaveLength(5);
    expect(update.state.author.authorPrs[PR]?.paidThreads).toEqual(['a', 'b', 'c', 'd', 'e']);
    const later = applyAuthorActivity(update.state, activity([...threads, thread('h')]), at(11));
    expect(later.xpGained).toBe(0);
  });

  test('a merge or an approval from before tracking started never pays', () => {
    const update = applyAuthorActivity(
      tracked(),
      activity([merged({ mergedAt: iso(1, 6) }), approved(iso(1, 6))]),
      at(10),
    );

    expect(update.xpGained).toBe(0);
    expect(update.state.author.authorPrs[PR]).toMatchObject({ merged: true, approved: true });
    expect(update.state.author.merges).toBe(0);
  });

  test('a later approval never pays when the first came before tracking started', () => {
    const early = applyAuthorActivity(tracked(), activity([approved(iso(1, 6))]), at(5));
    const later = applyAuthorActivity(early.state, activity([approved(iso(1, 6))]), at(10));

    expect(early.xpGained + later.xpGained).toBe(0);
  });

  test('threads resolved on PRs open at the first sync are a baseline; later ones pay', () => {
    const first = applyAuthorActivity(initialGameState(), activity([thread('old')]), at(1));
    const later = applyAuthorActivity(first.state, activity([thread('old'), thread('new')]), at(2));

    expect(first.xpGained).toBe(0);
    expect(first.state.author.authorPrs[PR]?.baselineThreads).toEqual(['old']);
    expect(later.grants).toEqual([{ amount: 3, reason: 'threadResolved', questId: PR }]);
  });

  test('a PR created before tracking and first read later keeps its resolved threads as baseline', () => {
    const update = applyAuthorActivity(
      tracked(),
      activity([thread('x', iso(1, 6), 'Hard', OTHER)]),
      at(10),
    );

    expect(update.xpGained).toBe(0);
    expect(update.state.author.authorPrs[OTHER]?.baselineThreads).toEqual(['x']);
  });

  test('a PR created after tracking started pays for every resolved thread', () => {
    const update = applyAuthorActivity(tracked(), activity([thread('x', iso(5))]), at(10));

    expect(update.xpGained).toBe(3);
  });

  test('a closed PR that was never merged pays only its approval, and pays its merge if reopened and merged', () => {
    const closed = applyAuthorActivity(tracked(), activity([approved(iso(5))]), at(6));
    const reopened = applyAuthorActivity(
      closed.state,
      activity([approved(iso(5)), merged()]),
      at(10),
    );

    expect(closed.xpGained).toBe(10);
    expect(authorGrants(reopened)).toEqual([{ amount: 20, reason: 'prMerged', questId: PR }]);
  });

  test('a long-merged PR read again never pays twice', () => {
    const paid = applyAuthorActivity(tracked(), activity([merged()]), at(10));
    const muchLater = applyAuthorActivity(paid.state, activity([merged()]), at(30));

    expect(muchLater.xpGained).toBe(0);
    expect(muchLater.state.author.merges).toBe(1);
  });

  test('moves the sync point in the same update as the payouts, and holds it when left out', () => {
    const moved = applyAuthorActivity(
      tracked(),
      activity([merged()], { lastAuthorSync: iso(10) }),
      at(10),
    );
    const held = applyAuthorActivity(moved.state, activity([approved(iso(10))]), at(11));

    expect(moved.state.author.lastAuthorSync).toBe(iso(10));
    expect(authorXpOf(moved)).toBe(20);
    expect(held.state.author.lastAuthorSync).toBe(iso(10));
  });

  test('a merge credits the streak on the day it happened, a thread on the day it is noticed', () => {
    const update = applyAuthorActivity(
      tracked(),
      activity([merged({ mergedAt: iso(8) }), thread('t', iso(5), 'Hard', OTHER)]),
      at(10),
    );

    expect(update.state.activeDays).toEqual(['2026-11-08', '2026-11-10']);
  });

  test('an event older than the streak window pays XP but leaves the streak alone', () => {
    const update = applyAuthorActivity(
      {
        ...tracked(),
        author: { ...tracked().author, trackingSince: new Date(2026, 5, 1).toISOString() },
      },
      activity([merged({ mergedAt: new Date(2026, 6, 1, 12).toISOString() })]),
      at(10),
    );

    expect(authorXpOf(update)).toBe(20);
    expect(update.state.activeDays).toEqual([]);
  });

  test('author-only days keep the streak going', () => {
    let state = tracked();
    for (let dayOfMonth = 3; dayOfMonth <= 7; dayOfMonth++) {
      state = applyAuthorActivity(
        state,
        activity([thread(`t${dayOfMonth}`, iso(2), 'Hard', `o/r#${dayOfMonth}`)]),
        at(dayOfMonth),
      ).state;
    }

    expect(currentStreak(state, at(7))).toBe(5);
    expect(state.achievements.map((entry) => entry.id)).toContain('on-fire');
  });

  test('XP already earned is never taken back', () => {
    const paid = applyAuthorActivity(tracked(), activity([merged(), thread('a')]), at(10));
    const empty = applyAuthorActivity(paid.state, activity([]), at(11));

    expect(empty.state.xp).toBe(paid.state.xp);
  });
});

describe('authoring achievements', () => {
  const unlockedIds = (state: GameState): Array<string> =>
    state.achievements.map((entry) => entry.id);

  test('Ship It unlocks on the first paid merge', () => {
    const update = applyAuthorActivity(tracked(), activity([merged()]), at(10));

    expect(update.unlocked.map((entry) => entry.id)).toContain('ship-it');
  });

  test('All Tied Up needs a merged PR with at least three resolved threads', () => {
    const two = applyAuthorActivity(tracked(), activity([merged({ resolvedThreads: 2 })]), at(10));
    const three = applyAuthorActivity(
      two.state,
      activity([merged({ prId: OTHER, resolvedThreads: 3 })]),
      at(10),
    );

    expect(unlockedIds(two.state)).not.toContain('all-tied-up');
    expect(unlockedIds(three.state)).toContain('all-tied-up');
  });

  test('Small Batch needs five Trivial or Normal merges within seven days', () => {
    let state = tracked();
    const tiers: Array<DifficultyTier> = [
      'Trivial',
      'Normal',
      'Hard',
      'Normal',
      'Trivial',
      'Normal',
    ];
    tiers.forEach((tier, index) => {
      state = applyAuthorActivity(
        state,
        activity([merged({ prId: `o/r#${index + 10}`, tier, mergedAt: iso(3 + index) })]),
        at(3 + index),
      ).state;
    });

    expect(unlockedIds(state)).toContain('small-batch');
  });

  test('Small Batch does not count merges more than seven days apart', () => {
    let state = tracked();
    for (let index = 0; index < 5; index++) {
      const dayOfMonth = 2 + index * 2;
      state = applyAuthorActivity(
        state,
        activity([
          merged({ prId: `o/r#${index + 10}`, tier: 'Trivial', mergedAt: iso(dayOfMonth) }),
        ]),
        at(dayOfMonth),
      ).state;
    }

    expect(unlockedIds(state)).not.toContain('small-batch');
  });

  test('Flawless Victory counts only merges that never had changes requested', () => {
    let state = tracked();
    for (let index = 0; index < 11; index++) {
      state = applyAuthorActivity(
        state,
        activity([
          merged({
            prId: `o/r#${index + 10}`,
            everChangesRequested: index === 0,
            mergedAt: iso(10),
          }),
        ]),
        at(10),
      ).state;
    }

    expect(state.author).toMatchObject({ merges: 11, flawlessMerges: 10 });
    expect(unlockedIds(state)).toContain('flawless-victory');
  });
});
