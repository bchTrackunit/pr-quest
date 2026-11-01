import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '../../../shared/api.ts';
import { GameService } from './game.ts';
import type { ReviewAction } from './gamification.ts';
import { FileStateStore } from './store.ts';

let dir: string;
let store: FileStateStore;
let broadcast: ReturnType<typeof vi.fn<(event: ServerEvent) => void>>;
let game: GameService;
/** A Friday at noon, so no weekend or time-of-day achievement unlocks by accident. */
const now = new Date(2026, 9, 30, 12);

function openGame(target: FileStateStore): GameService {
  let eventCount = 0;
  return new GameService(
    target,
    { broadcast },
    { login: 'player', now: () => now, newEventId: () => `xp-${++eventCount}` },
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-game-'));
  store = await FileStateStore.open(dir);
  broadcast = vi.fn<(event: ServerEvent) => void>();
  game = openGame(store);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const approval: Omit<ReviewAction, 'at'> = {
  kind: 'approved',
  questId: 'o/r#1',
  difficulty: 'Normal',
  requestKind: 'direct',
  requestedAt: new Date(2026, 9, 30, 11, 30).toISOString(),
};

const eventTypes = (): Array<string> => broadcast.mock.calls.map(([event]) => event.type);

describe('GameService', () => {
  test('rewards an action, persists it and returns the outcome', async () => {
    const outcome = await game.recordReviewAction(approval);

    expect(outcome.xpGained).toBe(23 + 25 + 50);
    expect(outcome.unlocked.map((entry) => entry.id)).toEqual(['first-blood', 'quick-draw']);
    expect(outcome.player.xp).toBe(98);
    expect((await FileStateStore.open(dir)).state.game.xp).toBe(98);
  });

  test('broadcasts XP for the action, then each unlock with its XP', async () => {
    await game.recordReviewAction(approval);

    expect(eventTypes()).toEqual([
      'xpGained',
      'achievementUnlocked',
      'xpGained',
      'achievementUnlocked',
      'xpGained',
    ]);
    expect(broadcast.mock.calls[0]?.[0]).toMatchObject({
      type: 'xpGained',
      amount: 23,
      reason: 'approved',
      questId: 'o/r#1',
    });
    expect(broadcast.mock.calls[1]?.[0]).toMatchObject({
      type: 'achievementUnlocked',
      achievement: { id: 'first-blood', name: 'First Blood', rarity: 'common', xpReward: 25 },
    });
    expect(broadcast.mock.calls[2]?.[0]).toMatchObject({
      type: 'xpGained',
      amount: 25,
      achievementId: 'first-blood',
    });
  });

  test('returns each gain with the event id it was broadcast under', async () => {
    const outcome = await game.recordReviewAction(approval);

    expect(outcome.gains).toEqual([
      { eventId: 'xp-1', amount: 23, reason: 'approved', questId: 'o/r#1' },
      {
        eventId: 'xp-achievement-first-blood',
        amount: 25,
        reason: 'achievement',
        achievementId: 'first-blood',
      },
      {
        eventId: 'xp-achievement-quick-draw',
        amount: 50,
        reason: 'achievement',
        achievementId: 'quick-draw',
      },
    ]);
    const broadcastGains = broadcast.mock.calls.flatMap(([event]) =>
      event.type === 'xpGained' ? [{ eventId: event.eventId, amount: event.amount }] : [],
    );
    expect(broadcastGains).toEqual(
      outcome.gains.map(({ eventId, amount }) => ({ eventId, amount })),
    );
  });

  test('returns the definitions of what unlocked', async () => {
    const outcome = await game.recordReviewAction(approval);

    expect(outcome.achievements?.map((def) => [def.name, def.xpReward])).toEqual([
      ['First Blood', 25],
      ['Quick Draw', 50],
    ]);
  });

  test('a bonus is never paid twice, also after a restart', async () => {
    await game.recordReviewAction(approval);
    const reopened = openGame(await FileStateStore.open(dir));
    broadcast.mockClear();

    const outcome = await reopened.recordReviewAction({ ...approval, questId: 'o/r#2' });

    expect(outcome.unlocked).toEqual([]);
    expect(outcome.gains.map((gain) => gain.reason)).toEqual(['approved']);
    expect(eventTypes()).toEqual(['xpGained']);
    expect(reopened.player().xp).toBe(98 + 23);
  });

  test('a repeated approval returns no XP and broadcasts nothing', async () => {
    await game.recordReviewAction(approval);
    broadcast.mockClear();

    const outcome = await game.recordReviewAction(approval);

    expect(outcome).toMatchObject({ xpGained: 0, unlocked: [] });
    expect(broadcast).not.toHaveBeenCalled();
  });

  test('announces a hidden achievement by name, though the list shows it as ???', async () => {
    expect(game.achievements().find((status) => status.id === 'archaeologist')?.name).toBe('???');
    const board = [
      { id: 'o/r#1', requestedAt: approval.requestedAt, requestKind: 'direct' as const },
    ];

    const outcome = await game.recordReviewAction({ ...approval, board });

    expect(outcome.achievements?.map((def) => def.name)).toContain('Archaeologist');
    expect(broadcast.mock.calls.map(([event]) => event)).toContainEqual(
      expect.objectContaining({
        type: 'achievementUnlocked',
        achievement: expect.objectContaining({ id: 'archaeologist', name: 'Archaeologist' }),
      }),
    );
    expect(game.achievements().find((status) => status.id === 'archaeologist')?.name).toBe(
      'Archaeologist',
    );
  });

  test("the player's own PRs don't count toward Diplomat", async () => {
    await game.recordReviewAction({ ...approval, author: { name: 'Me', githubLogin: 'Player' } });
    await game.recordReviewAction({
      ...approval,
      questId: 'o/r#2',
      author: { name: 'Ada', githubLogin: 'ada' },
    });

    expect(game.achievements().find((status) => status.id === 'diplomat')?.progress).toBe(1);
  });

  test('an empty queue after an action today unlocks Inbox Zero', async () => {
    await game.recordReviewAction(approval);
    broadcast.mockClear();

    await game.recordQueueChecked(0);

    expect(eventTypes()).toEqual(['achievementUnlocked', 'xpGained']);
    expect(game.achievements().find((status) => status.id === 'inbox-zero')?.unlockedAt).toBe(
      now.toISOString(),
    );
  });

  test('finished agent reviews count toward Agent Commander and Second Opinion', async () => {
    await game.recordAgentReviewFinished({ questId: 'o/r#1', provider: 'cursor' });
    await game.recordAgentReviewFinished({ questId: 'O/R#1', provider: 'claude' });

    expect(game.player().counters.agentReviews).toBe(2);
    expect(game.achievements().find((status) => status.id === 'agent-commander')?.progress).toBe(2);
    expect(
      game.achievements().find((status) => status.id === 'second-opinion')?.unlockedAt,
    ).toBeDefined();
  });

  test("dates every action in the player's time zone, read again for each action", async () => {
    let clock = new Date('2026-11-10T23:30:00Z');
    let timeZone = 'America/Los_Angeles';
    const zoned = new GameService(
      store,
      { broadcast },
      { login: 'player', now: () => clock, timeZone: () => timeZone },
    );

    await zoned.recordReviewAction(approval);
    expect(zoned.player()).toMatchObject({ lastReviewDate: '2026-11-10', streakDays: 1 });

    timeZone = 'Europe/Copenhagen';
    clock = new Date('2026-11-11T23:30:00Z');
    await zoned.recordReviewAction({ ...approval, questId: 'o/r#2' });

    expect(zoned.player()).toMatchObject({ lastReviewDate: '2026-11-12', streakDays: 1 });
  });
});
