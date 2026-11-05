import { describe, expect, test } from 'vitest';

import {
  ACHIEVEMENT_IDS,
  type AchievementId,
  type AchievementRarity,
  type FindingSeverity,
  type PlayerCounters,
  type ReviewProvider,
} from '@pr-quest/contract/api';
import { ACHIEVEMENT_RULES, RARITY_XP } from './achievements.ts';
import {
  achievementStatuses,
  applyAgentReviewFinished,
  applyReviewAction,
  initialGameState,
  type BoardQuest,
  type GameState,
  type ReviewAction,
} from './gamification.ts';

/**
 * Local-time dates keep these tests independent of the machine's time zone. In November 2026 the
 * 2nd to the 6th are Monday to Friday and the 7th and 8th are a weekend.
 */
const at = (dayOfMonth: number, hour = 12, minute = 0): Date =>
  new Date(2026, 10, dayOfMonth, hour, minute);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PLAYER = { login: 'Player-Login' };

function action(overrides: Partial<ReviewAction> = {}): ReviewAction {
  return {
    kind: 'reviewPosted',
    questId: 'Acme/widgets#1',
    difficulty: 'Normal',
    requestKind: 'team',
    requestedAt: at(2, 9).toISOString(),
    at: at(4),
    ...overrides,
  };
}

function play(
  steps: Array<Partial<ReviewAction>>,
  state: GameState = initialGameState(),
): GameState {
  return steps.reduce(
    (current, overrides) => applyReviewAction(current, action(overrides), PLAYER).state,
    state,
  );
}

/** The ids one more action unlocks on top of `state`. */
function unlocks(state: GameState, overrides: Partial<ReviewAction>): Array<AchievementId> {
  return applyReviewAction(state, action(overrides), PLAYER).unlocked.map((entry) => entry.id);
}

const owned = (state: GameState): Array<AchievementId> =>
  state.achievements.map((entry) => entry.id);

const withCounters = (counters: Partial<PlayerCounters>): GameState => {
  const state = initialGameState();
  return { ...state, counters: { ...state.counters, ...counters } };
};

const status = (state: GameState, id: AchievementId, now: Date = at(4)) =>
  achievementStatuses(state, now).find((entry) => entry.id === id);

const prs = (count: number, prefix = 'Acme/widgets#') =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

describe('the achievement list', () => {
  test.each<[AchievementId, AchievementRarity]>([
    ['first-blood', 'common'],
    ['quick-draw', 'rare'],
    ['boss-slayer', 'rare'],
    ['team-player', 'rare'],
    ['inbox-zero', 'rare'],
    ['on-fire', 'epic'],
    ['agent-commander', 'rare'],
    ['necromancer', 'rare'],
    ['early-bird', 'common'],
    ['night-owl', 'common'],
    ['weekend-warrior', 'common'],
    ['centurion-bronze', 'common'],
    ['centurion-silver', 'rare'],
    ['centurion-gold', 'legendary'],
    ['unstoppable', 'legendary'],
    ['clean-sweep', 'epic'],
    ['giant-killer', 'epic'],
    ['featherweight', 'rare'],
    ['the-long-read', 'rare'],
    ['eagle-eye', 'common'],
    ['gatekeeper', 'rare'],
    ['second-opinion', 'rare'],
    ['explorer', 'rare'],
    ['diplomat', 'rare'],
    ['bot-wrangler', 'rare'],
    ['speedrunner', 'epic'],
    ['archaeologist', 'rare'],
  ])('%s is %s and its bonus matches the rarity', (id, rarity) => {
    const def = ACHIEVEMENT_RULES.find((rule) => rule.def.id === id)?.def;

    expect(def).toMatchObject({ rarity, xpReward: RARITY_XP[rarity] });
    expect(def?.category).toBeDefined();
  });

  test('bonus XP grows with rarity', () => {
    expect(RARITY_XP).toEqual({ common: 25, rare: 50, epic: 100, legendary: 200 });
  });

  test('lists every achievement id exactly once', () => {
    expect(ACHIEVEMENT_RULES.map((rule) => rule.def.id).toSorted()).toEqual(
      [...ACHIEVEMENT_IDS].toSorted(),
    );
  });

  test('Speedrunner and Archaeologist are the hidden ones, each with a hint', () => {
    const secret = ACHIEVEMENT_RULES.filter((rule) => rule.def.secret).map((rule) => rule.def);

    expect(secret.map((def) => def.id)).toEqual(['speedrunner', 'archaeologist']);
    expect(secret.every((def) => def.hint !== undefined && def.category === 'secret')).toBe(true);
  });
});

describe("time of day and week, by default in the machine's time zone", () => {
  test.each([
    [7, 59, true],
    [8, 0, false],
  ])('Early Bird at %i:%i: %s', (hour, minute, unlocked) => {
    expect(unlocks(initialGameState(), { at: at(4, hour, minute) }).includes('early-bird')).toBe(
      unlocked,
    );
  });

  test.each([
    [21, 59, false],
    [22, 0, true],
    [23, 59, true],
  ])('Night Owl at %i:%i: %s', (hour, minute, unlocked) => {
    expect(unlocks(initialGameState(), { at: at(4, hour, minute) }).includes('night-owl')).toBe(
      unlocked,
    );
  });

  test.each([
    ['Friday', 6, false],
    ['Saturday', 7, true],
    ['Sunday', 8, true],
    ['Monday', 9, false],
  ])('Weekend Warrior on a %s: %s', (_day, dayOfMonth, unlocked) => {
    expect(unlocks(initialGameState(), { at: at(dayOfMonth) }).includes('weekend-warrior')).toBe(
      unlocked,
    );
  });

  test('every review action kind counts, an approval included', () => {
    expect(unlocks(initialGameState(), { kind: 'approved', at: at(7, 22, 30) })).toEqual(
      expect.arrayContaining(['night-owl', 'weekend-warrior']),
    );
  });
});

describe("time of day and week, in the player's time zone", () => {
  const unlocksIn = (timeZone: string, iso: string): Array<AchievementId> =>
    applyReviewAction(initialGameState(), action({ at: new Date(iso) }), {
      ...PLAYER,
      timeZone,
    }).unlocked.map((entry) => entry.id);

  test.each([
    ['UTC', true],
    ['Europe/Copenhagen', false],
  ])('Early Bird at 07:30 UTC in %s: %s', (zone, unlocked) => {
    expect(unlocksIn(zone, '2026-11-04T07:30:00Z').includes('early-bird')).toBe(unlocked);
  });

  test.each([
    ['UTC', false],
    ['Europe/Copenhagen', true],
  ])('Night Owl at 21:30 UTC in %s: %s', (zone, unlocked) => {
    expect(unlocksIn(zone, '2026-11-04T21:30:00Z').includes('night-owl')).toBe(unlocked);
  });

  test.each([
    ['UTC', false],
    ['Europe/Copenhagen', true],
  ])('Weekend Warrior late on a Friday in UTC, in %s: %s', (zone, unlocked) => {
    expect(unlocksIn(zone, '2026-11-06T23:30:00Z').includes('weekend-warrior')).toBe(unlocked);
  });

  test('Early Bird follows the clocks going back', () => {
    // 06:30Z is 08:30 CEST the day before the change and 07:30 CET on the day of it.
    expect(unlocksIn('Europe/Copenhagen', '2026-10-24T06:30:00Z')).not.toContain('early-bird');
    expect(unlocksIn('Europe/Copenhagen', '2026-10-25T06:30:00Z')).toContain('early-bird');
  });

  test('Night Owl follows the clocks going forward', () => {
    // 20:30Z is 21:30 CET the day before the change and 22:30 CEST on the day of it.
    expect(unlocksIn('Europe/Copenhagen', '2026-03-28T20:30:00Z')).not.toContain('night-owl');
    expect(unlocksIn('Europe/Copenhagen', '2026-03-29T20:30:00Z')).toContain('night-owl');
  });
});

describe('Necromancer', () => {
  test.each([
    ['exactly 30 days', 30 * DAY, true],
    ['a minute under 30 days', 30 * DAY - MINUTE, false],
    ['45 days', 45 * DAY, true],
  ])('a PR that waited %s: %s', (_label, waited, unlocked) => {
    const requestedAt = new Date(at(4).getTime() - waited).toISOString();

    expect(unlocks(initialGameState(), { requestedAt }).includes('necromancer')).toBe(unlocked);
  });
});

describe('Centurion', () => {
  const tiers = ['centurion-bronze', 'centurion-silver', 'centurion-gold'] as const;

  test.each<[number, Array<AchievementId>]>([
    [9, []],
    [49, ['centurion-bronze']],
    [99, ['centurion-bronze', 'centurion-silver']],
  ])('with %i earlier actions, the next one unlocks the next tier', (earlier, ownedTiers) => {
    const before = withCounters({ approvals: earlier });
    const state = {
      ...before,
      achievements: ownedTiers.map((id) => ({ id, unlockedAt: at(1).toISOString() })),
    };
    const nextTier = tiers[ownedTiers.length];

    expect(unlocks(state, {})).toContain(nextTier);
  });

  test('nine actions are not enough for Bronze', () => {
    expect(owned(play(prs(9).map((questId) => ({ questId }))))).not.toContain('centurion-bronze');
  });

  test('a jump past several tiers unlocks each of them once', () => {
    expect(unlocks(withCounters({ reviewsPosted: 60, approvals: 39 }), {})).toEqual(
      expect.arrayContaining([...tiers]),
    );
  });

  test('each tier shows progress toward its own target', () => {
    const state = play(prs(12).map((questId) => ({ questId })));

    expect(status(state, 'centurion-bronze')).toMatchObject({ progress: 10, target: 10 });
    expect(status(state, 'centurion-bronze')?.unlockedAt).toBeDefined();
    expect(status(state, 'centurion-silver')).toMatchObject({
      progress: 12,
      target: 50,
      series: { id: 'centurion', name: 'Centurion', tier: 'silver' },
    });
  });
});

describe('Unstoppable', () => {
  const days = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ at: at(2 + index) }));

  test('needs a 7-day streak, on top of On Fire at 5', () => {
    expect(owned(play(days(6)))).toEqual(expect.arrayContaining(['on-fire']));
    expect(owned(play(days(6)))).not.toContain('unstoppable');
    expect(owned(play(days(7)))).toContain('unstoppable');
  });
});

describe('Clean Sweep', () => {
  const direct = (index: number): BoardQuest => ({
    id: `Acme/widgets#${index}`,
    requestedAt: at(2).toISOString(),
    requestKind: 'direct',
  });
  const team: BoardQuest = {
    id: 'Acme/widgets#90',
    requestedAt: at(1).toISOString(),
    requestKind: 'team',
  };

  /** Acts on direct requests 1..count, each time with the rest still on the board. */
  function sweep(count: number, extra: Array<BoardQuest> = []): Array<Partial<ReviewAction>> {
    return Array.from({ length: count }, (_, index) => ({
      questId: `Acme/widgets#${index + 1}`,
      requestKind: 'direct',
      board: [
        ...Array.from({ length: count - index }, (_unused, offset) => direct(index + 1 + offset)),
        ...extra,
      ],
    }));
  }

  test('5 direct requests acted on today and none left on the board unlocks it', () => {
    expect(owned(play(sweep(5, [team])))).toContain('clean-sweep');
  });

  test('4 direct requests are not enough', () => {
    expect(owned(play(sweep(4)))).not.toContain('clean-sweep');
  });

  test('another direct request still waiting blocks it', () => {
    expect(owned(play(sweep(5, [direct(42)])))).not.toContain('clean-sweep');
  });

  test('direct requests from an earlier day do not count', () => {
    const yesterday = play(sweep(4).map((step) => ({ ...step, at: at(3) })));

    expect(
      unlocks(yesterday, { questId: 'Acme/widgets#5', requestKind: 'direct', board: [direct(5)] }),
    ).not.toContain('clean-sweep');
  });

  test('without a board snapshot it never unlocks', () => {
    const steps = sweep(5).map(({ board: _board, ...step }) => step);

    expect(owned(play(steps))).not.toContain('clean-sweep');
  });

  test('shows how many direct requests were acted on today', () => {
    const state = play(sweep(3, [direct(42)]));

    expect(status(state, 'clean-sweep')).toMatchObject({ progress: 3, target: 5, daily: true });
    expect(status(state, 'clean-sweep', at(5))?.progress).toBe(0);
  });
});

describe('Giant Killer', () => {
  test('needs 5 Boss-tier approvals', () => {
    const approvals = (count: number) =>
      prs(count).map((questId) => ({
        questId,
        kind: 'approved' as const,
        difficulty: 'Boss' as const,
      }));

    expect(owned(play(approvals(4)))).not.toContain('giant-killer');
    expect(owned(play(approvals(5)))).toContain('giant-killer');
  });

  test('reviews of Boss PRs and approvals of Hard ones do not count', () => {
    const steps = prs(5).flatMap((questId) => [
      { questId, difficulty: 'Boss' as const },
      { questId: `${questId}0`, kind: 'approved' as const, difficulty: 'Hard' as const },
    ]);

    expect(status(play(steps), 'giant-killer')?.progress).toBe(0);
  });
});

describe('Featherweight', () => {
  const reviewThenApprove = (questId: string, when: Date) => [
    { questId, difficulty: 'Trivial' as const, at: when },
    { questId, difficulty: 'Trivial' as const, kind: 'approved' as const, at: when },
  ];

  test('10 Trivial approvals in one day, each after a posted review, unlock it', () => {
    expect(owned(play(prs(10).flatMap((id) => reviewThenApprove(id, at(4)))))).toContain(
      'featherweight',
    );
  });

  test('approvals without a review first are rubber stamps and do not count', () => {
    const state = play(
      prs(10).map((questId) => ({
        questId,
        difficulty: 'Trivial' as const,
        kind: 'approved' as const,
      })),
    );

    expect(owned(state)).not.toContain('featherweight');
    expect(status(state, 'featherweight')?.progress).toBe(0);
  });

  test('a finished agent review also counts as the review first', () => {
    let state = initialGameState();
    for (const questId of prs(10)) {
      state = applyAgentReviewFinished(state, { questId, provider: 'claude' }, at(4, 9)).state;
    }

    const approved = play(
      prs(10).map((questId) => ({
        questId,
        difficulty: 'Trivial' as const,
        kind: 'approved' as const,
      })),
      state,
    );

    expect(owned(approved)).toContain('featherweight');
  });

  test('the 10 must fall on one day', () => {
    const steps = prs(10).flatMap((id, index) => reviewThenApprove(id, index < 9 ? at(4) : at(5)));

    expect(owned(play(steps))).not.toContain('featherweight');
  });

  test('Normal-tier approvals do not count', () => {
    const steps = prs(10).flatMap((questId) => [
      { questId },
      { questId, kind: 'approved' as const },
    ]);

    expect(status(play(steps), 'featherweight')?.progress).toBe(0);
  });
});

describe('The Long Read', () => {
  test.each([
    [1500, 499, false],
    [1500, 500, true],
  ])('%i additions and %i deletions: %s', (additions, deletions, unlocked) => {
    expect(
      unlocks(initialGameState(), { diffStats: { additions, deletions } }).includes(
        'the-long-read',
      ),
    ).toBe(unlocked);
  });

  test('an action without diff stats never counts', () => {
    expect(unlocks(initialGameState(), {})).not.toContain('the-long-read');
  });
});

describe('Eagle Eye', () => {
  test.each<[Array<FindingSeverity>, boolean]>([
    [['minor', 'major'], true],
    [['critical'], true],
    [['minor', 'nit'], false],
    [[], false],
  ])('a posted review with %o findings: %s', (postedSeverities, unlocked) => {
    expect(unlocks(initialGameState(), { postedSeverities }).includes('eagle-eye')).toBe(unlocked);
  });

  test('a request for changes with a critical finding counts too', () => {
    expect(
      unlocks(initialGameState(), { kind: 'changesRequested', postedSeverities: ['critical'] }),
    ).toContain('eagle-eye');
  });
});

describe('Gatekeeper', () => {
  test('needs changes requested on 5 different PRs', () => {
    const requests = (questIds: Array<string>) =>
      questIds.map((questId) => ({ questId, kind: 'changesRequested' as const }));

    expect(owned(play(requests(prs(5))))).toContain('gatekeeper');
    expect(owned(play(requests(prs(4))))).not.toContain('gatekeeper');
    expect(owned(play(requests(Array.from({ length: 5 }, () => 'Acme/widgets#1'))))).not.toContain(
      'gatekeeper',
    );
  });
});

describe('Second Opinion', () => {
  const finish = (state: GameState, questId: string, provider: ReviewProvider) =>
    applyAgentReviewFinished(state, { questId, provider }, at(4));

  test('finished Claude and Cursor reviews of the same PR unlock it, whatever the case', () => {
    const afterCursor = finish(initialGameState(), 'Acme/Widgets#7', 'cursor');
    const afterClaude = finish(afterCursor.state, 'acme/widgets#7', 'claude');

    expect(afterCursor.unlocked).toEqual([]);
    expect(afterClaude.unlocked.map((entry) => entry.id)).toContain('second-opinion');
  });

  test('two reviews by one provider, or reviews of different PRs, do not', () => {
    const sameProvider = finish(
      finish(initialGameState(), 'Acme/widgets#7', 'cursor').state,
      'Acme/widgets#7',
      'cursor',
    );
    const differentPrs = finish(
      finish(initialGameState(), 'Acme/widgets#7', 'cursor').state,
      'Acme/widgets#8',
      'claude',
    );

    expect(owned(sameProvider.state)).not.toContain('second-opinion');
    expect(owned(differentPrs.state)).not.toContain('second-opinion');
  });
});

describe('variety', () => {
  test('Explorer needs actions in 10 different repos and shows its progress', () => {
    const inRepos = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ questId: `Acme/repo-${index}#1` }));

    expect(status(play(inRepos(3)), 'explorer')).toMatchObject({ progress: 3, target: 10 });
    expect(owned(play(inRepos(9)))).not.toContain('explorer');
    expect(owned(play(inRepos(10)))).toContain('explorer');
    expect(status(play([...inRepos(3), ...inRepos(3)]), 'explorer')?.progress).toBe(3);
  });

  test('Diplomat needs 10 different authors and never counts the player', () => {
    const byAuthors = (logins: Array<string>) =>
      logins.map((githubLogin, index) => ({
        questId: `Acme/widgets#${index + 1}`,
        author: { name: githubLogin, githubLogin },
      }));
    const nine = Array.from({ length: 9 }, (_, index) => `author-${index}`);

    expect(owned(play(byAuthors([...nine, 'player-login'])))).not.toContain('diplomat');
    expect(status(play(byAuthors([...nine, 'PLAYER-LOGIN'])), 'diplomat')?.progress).toBe(9);
    expect(owned(play(byAuthors([...nine, 'author-9'])))).toContain('diplomat');
  });

  test('Diplomat never counts bots; Bot Wrangler covers those', () => {
    const bots = [
      'dependabot',
      'Renovate',
      'dependabot[bot]',
      'app/renovate',
      'github-actions[bot]',
      'app/some-integration',
    ];
    const steps = [...bots, 'author-0'].map((githubLogin, index) => ({
      questId: `Acme/widgets#${index + 1}`,
      author: { name: githubLogin, githubLogin },
    }));

    expect(status(play(steps), 'diplomat')?.progress).toBe(1);
    expect(status(play(steps), 'bot-wrangler')?.progress).toBe(4);
  });

  test('Bot Wrangler counts Dependabot and Renovate PRs in every login form', () => {
    const logins = [
      'dependabot[bot]',
      'renovate[bot]',
      'app/dependabot',
      'app/renovate',
      'Dependabot',
    ];
    const steps = [...logins, ...logins].map((githubLogin, index) => ({
      questId: `Acme/widgets#${index + 1}`,
      author: { name: githubLogin, githubLogin },
    }));

    expect(status(play(steps.slice(0, 9)), 'bot-wrangler')?.progress).toBe(9);
    expect(owned(play(steps))).toContain('bot-wrangler');
  });

  test('Bot Wrangler counts each PR once and ignores people', () => {
    const steps = [
      ...Array.from({ length: 10 }, () => ({
        questId: 'Acme/widgets#1',
        author: { name: 'dependabot', githubLogin: 'dependabot[bot]' },
      })),
      { questId: 'Acme/widgets#2', author: { name: 'Renovate Fan', githubLogin: 'renovate-fan' } },
    ];

    expect(status(play(steps), 'bot-wrangler')?.progress).toBe(1);
  });
});

describe('hidden achievements', () => {
  test('Speedrunner: an approval within 5 minutes of the PR opening, after a review', () => {
    const requestedAt = at(4, 12).toISOString();
    const reviewed = play([{ requestedAt, at: at(4, 12, 2) }]);

    expect(unlocks(reviewed, { kind: 'approved', requestedAt, at: at(4, 12, 5) })).toContain(
      'speedrunner',
    );
    expect(
      unlocks(reviewed, {
        kind: 'approved',
        requestedAt,
        at: new Date(at(4, 12, 5).getTime() + 1000),
      }),
    ).not.toContain('speedrunner');
  });

  test('Speedrunner never counts a rubber stamp', () => {
    const requestedAt = at(4, 12).toISOString();

    expect(
      unlocks(initialGameState(), { kind: 'approved', requestedAt, at: at(4, 12, 1) }),
    ).not.toContain('speedrunner');
  });

  test('Archaeologist: acting on the quest that waited longest on the board', () => {
    const board: Array<BoardQuest> = [
      { id: 'Acme/widgets#1', requestedAt: at(1).toISOString(), requestKind: 'team' },
      { id: 'Acme/widgets#2', requestedAt: at(2).toISOString(), requestKind: 'direct' },
    ];

    expect(
      unlocks(initialGameState(), {
        questId: 'Acme/widgets#1',
        requestedAt: at(1).toISOString(),
        board,
      }),
    ).toContain('archaeologist');
    expect(
      unlocks(initialGameState(), {
        questId: 'Acme/widgets#2',
        requestedAt: at(2).toISOString(),
        board,
      }),
    ).not.toContain('archaeologist');
  });

  test('Archaeologist needs the quest to be on the board', () => {
    const board: Array<BoardQuest> = [
      { id: 'Acme/widgets#2', requestedAt: at(2).toISOString(), requestKind: 'direct' },
    ];

    expect(
      unlocks(initialGameState(), {
        questId: 'Acme/widgets#1',
        requestedAt: at(1).toISOString(),
        board,
      }),
    ).not.toContain('archaeologist');
  });

  test('a locked hidden achievement is listed as ??? with its hint, an unlocked one in full', () => {
    const board: Array<BoardQuest> = [
      { id: 'Acme/widgets#1', requestedAt: at(2, 9).toISOString(), requestKind: 'team' },
    ];
    const state = play([{ board }]);

    expect(status(initialGameState(), 'archaeologist')).toMatchObject({
      name: '???',
      icon: '❔',
      secret: true,
      description: expect.not.stringMatching(/oldest/i),
    });
    expect(status(initialGameState(), 'archaeologist')?.description).toBe(
      status(initialGameState(), 'archaeologist')?.hint,
    );
    expect(status(state, 'archaeologist')).toMatchObject({ name: 'Archaeologist', secret: true });
    expect(status(state, 'speedrunner')?.name).toBe('???');
  });
});

describe('bonus XP on unlock', () => {
  test('each unlock grants its rarity bonus once, tagged with the achievement', () => {
    const first = applyReviewAction(initialGameState(), action({ at: at(7, 7) }), PLAYER);

    expect(first.grants).toEqual([
      { amount: 30, reason: 'reviewPosted', questId: 'Acme/widgets#1' },
      { amount: 25, reason: 'achievement', achievementId: 'first-blood' },
      { amount: 25, reason: 'achievement', achievementId: 'early-bird' },
      { amount: 25, reason: 'achievement', achievementId: 'weekend-warrior' },
    ]);
    expect(first.state.xp).toBe(30 + 75);

    const second = applyReviewAction(
      first.state,
      action({ questId: 'Acme/widgets#2', at: at(7, 7, 30) }),
      PLAYER,
    );

    expect(second.grants).toEqual([
      { amount: 30, reason: 'reviewPosted', questId: 'Acme/widgets#2' },
    ]);
  });

  test('an achievement unlocked before bonuses changed is never paid again', () => {
    const before: GameState = {
      ...withCounters({ approvals: 2, reviewsPosted: 2, agentReviews: 5, teamReviews: 2 }),
      xp: 90,
      achievements: [{ id: 'first-blood', unlockedAt: '2026-10-30T20:56:08.445Z' }],
    };

    const update = applyReviewAction(before, action({ questId: 'Acme/widgets#9' }), PLAYER);

    expect(update.unlocked).toEqual([]);
    expect(update.state.xp).toBe(90 + 30);
  });

  test('a bonus that crosses a level boundary levels up with the action XP', () => {
    const before: GameState = { ...withCounters({ approvals: 9 }), xp: 60 };

    const update = applyReviewAction(before, action({ questId: 'Acme/widgets#9' }), PLAYER);

    expect(update.unlocked.map((entry) => entry.id)).toContain('centurion-bronze');
    expect(update.state.xp).toBeGreaterThanOrEqual(100);
  });
});
