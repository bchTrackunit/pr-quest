import { randomUUID } from 'node:crypto';

import type {
  AchievementStatus,
  GameOutcome,
  PlayerState,
  ServerEvent,
  XpGain,
} from '../shared/api.ts';
import { achievementDef } from './achievements.ts';
import {
  achievementStatuses,
  applyAgentReviewFinished,
  applyQueueChecked,
  applyReviewAction,
  toPlayerState,
  type GameState,
  type GameUpdate,
  type ReviewAction,
} from './gamification.ts';
import type { StateStore } from './store.ts';

export interface EventSink {
  broadcast(event: ServerEvent): void;
}

/** Applies the game rules to the persisted state and announces XP and unlocks over SSE. */
export class GameService {
  private readonly store: StateStore;
  private readonly events: EventSink;
  private readonly now: () => Date;
  private readonly newEventId: () => string;

  public constructor(
    store: StateStore,
    events: EventSink,
    now: () => Date = () => new Date(),
    newEventId: () => string = () => `xp-${randomUUID()}`,
  ) {
    this.store = store;
    this.events = events;
    this.now = now;
    this.newEventId = newEventId;
  }

  public player(): PlayerState {
    return toPlayerState(this.store.state.game, this.now());
  }

  public achievements(): Array<AchievementStatus> {
    return achievementStatuses(this.store.state.game, this.now());
  }

  public recordReviewAction(action: Omit<ReviewAction, 'at'>): Promise<GameOutcome> {
    return this.apply((game, at) => applyReviewAction(game, { ...action, at }));
  }

  public async recordAgentReviewFinished(): Promise<void> {
    await this.apply(applyAgentReviewFinished);
  }

  public async recordQueueChecked(questCount: number): Promise<void> {
    await this.apply((game, at) => applyQueueChecked(game, { questCount, at }));
  }

  private async apply(rule: (game: GameState, at: Date) => GameUpdate): Promise<GameOutcome> {
    const at = this.now();
    let update: GameUpdate | undefined;
    await this.store.update((state) => {
      update = rule(state.game, at);
      return update.state === state.game ? state : { ...state, game: update.state };
    });
    if (!update) {
      throw new Error('Game update did not run');
    }
    const player = toPlayerState(update.state, at);
    const gains = update.grants.map((grant): XpGain => ({ eventId: this.newEventId(), ...grant }));
    this.announce(update, gains, player, at);
    return { xpGained: update.xpGained, gains, player, unlocked: update.unlocked };
  }

  /** Broadcasts the action's XP, then each unlock followed by its XP. */
  private announce(update: GameUpdate, gains: Array<XpGain>, player: PlayerState, at: Date): void {
    for (const gain of gains.filter((entry) => entry.reason !== 'achievement')) {
      this.events.broadcast({ type: 'xpGained', ...gain, player });
    }
    const achievementGains = gains.filter((entry) => entry.reason === 'achievement');
    update.unlocked.forEach((unlocked, index) => {
      const achievement = achievementDef(unlocked.id);
      if (achievement) {
        this.events.broadcast({
          type: 'achievementUnlocked',
          achievement,
          unlockedAt: at.toISOString(),
        });
      }
      const gain = achievementGains.at(index);
      if (gain) {
        this.events.broadcast({ type: 'xpGained', ...gain, player });
      }
    });
  }
}
