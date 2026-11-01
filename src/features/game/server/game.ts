import { randomUUID } from 'node:crypto';

import type {
  AchievementDef,
  AchievementId,
  AchievementStatus,
  GameOutcome,
  PlayerState,
  ServerEvent,
  XpGain,
} from '../../../shared/api.ts';
import { achievementDef } from './achievements.ts';
import {
  achievementStatuses,
  applyAgentReviewFinished,
  applyQueueChecked,
  applyReviewAction,
  toPlayerState,
  type FinishedReview,
  type GameState,
  type GameUpdate,
  type ReviewAction,
} from './gamification.ts';
import type { StateStore } from './store.ts';

export interface EventSink {
  broadcast(event: ServerEvent): void;
}

export interface GameServiceOptions {
  /** The player's GitHub login; their own PRs don't count toward Diplomat. */
  login?: string;
  now?: () => Date;
  /** Ids for action XP. Achievement bonuses always use `achievementEventId`. */
  newEventId?: () => string;
}

/** An achievement unlocks once, so its bonus has one id, the same after a restart or a replay. */
export function achievementEventId(id: AchievementId): string {
  return `xp-achievement-${id}`;
}

/** Applies the game rules to the persisted state and announces XP and unlocks over SSE. */
export class GameService {
  private readonly store: StateStore;
  private readonly events: EventSink;
  private readonly login?: string;
  private readonly now: () => Date;
  private readonly newEventId: () => string;

  public constructor(store: StateStore, events: EventSink, options: GameServiceOptions = {}) {
    this.store = store;
    this.events = events;
    this.login = options.login;
    this.now = options.now ?? (() => new Date());
    this.newEventId = options.newEventId ?? (() => `xp-${randomUUID()}`);
  }

  public player(): PlayerState {
    return toPlayerState(this.store.state.game, this.now());
  }

  public achievements(): Array<AchievementStatus> {
    return achievementStatuses(this.store.state.game, this.now());
  }

  public recordReviewAction(action: Omit<ReviewAction, 'at'>): Promise<GameOutcome> {
    return this.apply((game, at) =>
      applyReviewAction(game, { ...action, at }, this.login ? { login: this.login } : {}),
    );
  }

  public async recordAgentReviewFinished(review: FinishedReview): Promise<void> {
    await this.apply((game, at) => applyAgentReviewFinished(game, review, at));
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
    const gains = update.grants.map((grant): XpGain => ({
      eventId: grant.achievementId ? achievementEventId(grant.achievementId) : this.newEventId(),
      ...grant,
    }));
    const unlockedDefs = update.unlocked.flatMap((entry) => achievementDef(entry.id) ?? []);
    this.announce(unlockedDefs, gains, player, at);
    const outcome: GameOutcome = {
      xpGained: update.xpGained,
      gains,
      player,
      unlocked: update.unlocked,
    };
    if (unlockedDefs.length > 0) {
      outcome.achievements = unlockedDefs;
    }
    return outcome;
  }

  /** Broadcasts the action's XP, then each unlock followed by its bonus. */
  private announce(
    unlocked: Array<AchievementDef>,
    gains: Array<XpGain>,
    player: PlayerState,
    at: Date,
  ): void {
    for (const gain of gains.filter((entry) => entry.reason !== 'achievement')) {
      this.events.broadcast({ type: 'xpGained', ...gain, player });
    }
    for (const achievement of unlocked) {
      this.events.broadcast({
        type: 'achievementUnlocked',
        achievement,
        unlockedAt: at.toISOString(),
      });
      const gain = gains.find((entry) => entry.achievementId === achievement.id);
      if (gain) {
        this.events.broadcast({ type: 'xpGained', ...gain, player });
      }
    }
  }
}
