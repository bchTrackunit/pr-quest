import type { AchievementStatus, GameOutcome, PlayerState, ServerEvent } from '../shared/api.ts';
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

  public constructor(store: StateStore, events: EventSink, now: () => Date = () => new Date()) {
    this.store = store;
    this.events = events;
    this.now = now;
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
    this.announce(update, player, at);
    return { xpGained: update.xpGained, player, unlocked: update.unlocked };
  }

  private announce(update: GameUpdate, player: PlayerState, at: Date): void {
    for (const grant of update.grants.filter((entry) => entry.reason !== 'achievement')) {
      this.events.broadcast({ type: 'xpGained', ...grant, player });
    }
    for (const unlocked of update.unlocked) {
      const achievement = achievementDef(unlocked.id);
      if (!achievement) {
        continue;
      }
      this.events.broadcast({
        type: 'achievementUnlocked',
        achievement,
        unlockedAt: at.toISOString(),
      });
      this.events.broadcast({
        type: 'xpGained',
        amount: achievement.xpReward,
        reason: 'achievement',
        player,
      });
    }
  }
}
