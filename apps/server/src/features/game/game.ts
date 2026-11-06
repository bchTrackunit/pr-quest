import { randomUUID } from 'node:crypto';

import type {
  AchievementDef,
  AchievementId,
  AchievementStatus,
  GameOutcome,
  PlayerState,
  ServerEvent,
  XpGain,
} from '@pr-quest/contract/api';
import { achievementDef } from './achievements.ts';
import { applyAuthorActivity } from './authorActivity.ts';
import type { AuthorActivity } from './authorLedger.ts';
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

/** Undelivered author XP notices kept for the next tab; achievement unlocks are always kept. */
export const MAX_UNDELIVERED_XP_NOTICES = 50;

export interface EventSink {
  /** Returns how many open tabs received the event. */
  broadcast(event: ServerEvent): number;
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

type Notice = Extract<ServerEvent, { type: 'xpGained' | 'achievementUnlocked' }>;

/** Applies the game rules to the persisted state and announces XP and unlocks over SSE. */
export class GameService {
  private readonly store: StateStore;
  private readonly events: EventSink;
  private readonly login?: string;
  private readonly now: () => Date;
  private readonly newEventId: () => string;
  /** Author notices no tab received, oldest first, until a tab connects. */
  private undelivered: Array<Notice> = [];

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

  /**
   * Where the next read of merged and closed PRs starts: the last sync, or while the first one
   * holds, when tracking started. `undefined` before any sync.
   */
  public authorSyncPoint(): string | undefined {
    const { author } = this.store.state.game;
    return author.lastAuthorSync ?? author.trackingSince;
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

  /**
   * Pays author XP for what a sync read and moves the sync point, in one write. Its notices are
   * usually noticed with no tab open, so the ones no tab receives wait for the next tab.
   */
  public async recordAuthorActivity(activity: AuthorActivity): Promise<GameOutcome> {
    return this.apply((game, at) => applyAuthorActivity(game, activity, at), {
      keepUndelivered: true,
    });
  }

  /**
   * The author notices no tab has received yet, for a tab that just connected; each is handed out
   * once. XP notices carry the player as of now, so the header never goes back to older values.
   */
  public takeUndeliveredNotices(): Array<ServerEvent> {
    const notices = this.undelivered;
    this.undelivered = [];
    if (notices.length === 0) {
      return [];
    }
    const player = this.player();
    return notices.map((notice) => (notice.type === 'xpGained' ? { ...notice, player } : notice));
  }

  private async apply(
    rule: (game: GameState, at: Date) => GameUpdate,
    options: { keepUndelivered?: boolean } = {},
  ): Promise<GameOutcome> {
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
    this.announce(unlockedDefs, gains, player, at, options.keepUndelivered ?? false);
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
    keepUndelivered: boolean,
  ): void {
    const send = (notice: Notice): void => {
      if (this.events.broadcast(notice) === 0 && keepUndelivered) {
        this.keep(notice);
      }
    };
    for (const gain of gains.filter((entry) => entry.reason !== 'achievement')) {
      send({ type: 'xpGained', ...gain, player });
    }
    for (const achievement of unlocked) {
      send({ type: 'achievementUnlocked', achievement, unlockedAt: at.toISOString() });
      const gain = gains.find((entry) => entry.achievementId === achievement.id);
      if (gain) {
        send({ type: 'xpGained', ...gain, player });
      }
    }
  }

  /** Drops the oldest XP notices past the limit, never an unlock. */
  private keep(notice: Notice): void {
    this.undelivered.push(notice);
    let excess =
      this.undelivered.filter((entry) => entry.type === 'xpGained').length -
      MAX_UNDELIVERED_XP_NOTICES;
    if (excess <= 0) {
      return;
    }
    this.undelivered = this.undelivered.filter((entry) => {
      if (excess > 0 && entry.type === 'xpGained') {
        excess--;
        return false;
      }
      return true;
    });
  }
}
