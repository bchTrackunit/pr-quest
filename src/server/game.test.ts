import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '../shared/api.ts';
import { GameService } from './game.ts';
import type { ReviewAction } from './gamification.ts';
import { StateStore } from './store.ts';

let dir: string;
let store: StateStore;
let broadcast: ReturnType<typeof vi.fn<(event: ServerEvent) => void>>;
let game: GameService;
const now = new Date(2026, 9, 30, 12);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pr-quest-game-'));
  store = await StateStore.open(dir);
  broadcast = vi.fn<(event: ServerEvent) => void>();
  let eventCount = 0;
  game = new GameService(
    store,
    { broadcast },
    () => now,
    () => `xp-${++eventCount}`,
  );
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

    expect(outcome.xpGained).toBe(23 + 10 + 25);
    expect(outcome.unlocked.map((entry) => entry.id)).toEqual(['first-blood', 'quick-draw']);
    expect(outcome.player.xp).toBe(58);
    expect((await StateStore.open(dir)).state.game.xp).toBe(58);
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
      achievement: { id: 'first-blood', name: 'First Blood' },
    });
  });

  test('returns each gain with the event id it was broadcast under', async () => {
    const outcome = await game.recordReviewAction(approval);

    expect(outcome.gains).toEqual([
      { eventId: 'xp-1', amount: 23, reason: 'approved', questId: 'o/r#1' },
      { eventId: 'xp-2', amount: 10, reason: 'achievement' },
      { eventId: 'xp-3', amount: 25, reason: 'achievement' },
    ]);
    const broadcastGains = broadcast.mock.calls.flatMap(([event]) =>
      event.type === 'xpGained' ? [{ eventId: event.eventId, amount: event.amount }] : [],
    );
    expect(broadcastGains).toEqual(
      outcome.gains.map(({ eventId, amount }) => ({ eventId, amount })),
    );
  });

  test('a repeated approval returns no XP and broadcasts nothing', async () => {
    await game.recordReviewAction(approval);
    broadcast.mockClear();

    const outcome = await game.recordReviewAction(approval);

    expect(outcome).toMatchObject({ xpGained: 0, unlocked: [] });
    expect(broadcast).not.toHaveBeenCalled();
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

  test('finished agent reviews count toward Agent Commander', async () => {
    await game.recordAgentReviewFinished();

    expect(game.player().counters.agentReviews).toBe(1);
    expect(game.achievements().find((status) => status.id === 'agent-commander')?.progress).toBe(1);
  });
});
