import type { ListQuestsResponse, Quest, ServerEvent } from '@pr-quest/contract/api';
import type { EventSink, GameService } from '../game/index.ts';
import { IncompleteQuestListError, toQuest, type GitHubClient } from './github.ts';
import type { LinearReviewClient } from './linear.ts';
import type { QuestCache, QuestSnapshot } from './questCache.ts';
import { sortQuests } from './quests.ts';
import {
  detectRateLimit,
  nextBackoff,
  rateLimitResetOf,
  type Backoff,
} from '../../platform/rateLimit.ts';

export const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_ACTED_ON_HOLD_MS = 5 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000;
/** The automatic retry after a backoff waits this much past `limitedUntil`. */
const RETRY_MARGIN_MS = 1000;

export interface QuestServiceOptions {
  github: Pick<GitHubClient, 'fetchReviewRequests' | 'fetchRateLimitReset'>;
  linear: Pick<LinearReviewClient, 'getReviewInfo' | 'lookup'>;
  events: EventSink;
  game: Pick<GameService, 'recordQueueChecked'>;
  activeRunIdFor: (questId: string) => string | undefined;
  log: (message: string) => void;
  now?: () => Date;
  /** Keeps the last good quest list and any backoff across restarts. */
  cache?: Pick<QuestCache, 'load' | 'save'>;
  /** `list()` serves the cached quests while they are younger than this. */
  cacheTtlMs?: number;
  /**
   * How long a quest the player just approved or reviewed stays hidden. GitHub search lags behind
   * review submissions, so without this the quest would reappear on the next refresh.
   */
  actedOnHoldMs?: number;
}

/** GitHub is rate limited and there are no cached quests to serve instead. */
export class RateLimitedError extends Error {
  public readonly limitedUntil: Date;

  public constructor(backoff: Backoff) {
    super(
      `GitHub rate limit reached; PR Quest will try again after ${backoff.limitedUntil.toISOString()}`,
    );
    this.name = 'RateLimitedError';
    this.limitedUntil = backoff.limitedUntil;
  }
}

/**
 * The player's review queue: GitHub as the source of truth, Linear as optional enrichment. The
 * last good list is cached on disk; while GitHub rate limits us, no GitHub calls are made and the
 * cached list is served with the rate-limit status.
 */
export class QuestService {
  private readonly options: QuestServiceOptions;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private readonly actedOnHoldMs: number;
  private readonly actedOn = new Map<string, number>();
  private snapshot?: QuestSnapshot;
  private backoff?: Backoff;
  private inFlight?: Promise<ListQuestsResponse>;
  private polling = false;
  private retryTimer?: NodeJS.Timeout;

  public constructor(options: QuestServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.actedOnHoldMs = options.actedOnHoldMs ?? DEFAULT_ACTED_ON_HOLD_MS;
  }

  /** Loads the cached quests and backoff from disk, so a restart can serve them right away. */
  public async restore(): Promise<void> {
    const cached = await this.options.cache?.load();
    this.snapshot ??= cached?.snapshot;
    this.backoff ??= cached?.backoff;
  }

  /** Serves the cache while it is fresh or GitHub is rate limited; otherwise refreshes. */
  public async list(options: { force?: boolean } = {}): Promise<ListQuestsResponse> {
    const fresh =
      this.snapshot && this.now().getTime() - this.snapshot.fetchedAt.getTime() < this.cacheTtlMs;
    return !options.force && fresh ? this.response() : this.refresh();
  }

  /**
   * Fetches the queue and broadcasts it; concurrent callers share one fetch. During a backoff it
   * makes no GitHub call and returns the cached quests, or rejects with `RateLimitedError`.
   */
  public async refresh(): Promise<ListQuestsResponse> {
    const backoff = this.activeBackoff();
    if (backoff) {
      return this.cachedDuring(backoff);
    }
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public find(id: string): Quest | undefined {
    return this.board()?.find((quest) => quest.id === id);
  }

  /** The quests the board shows now, without the ones just acted on; `undefined` before a fetch. */
  public board(): Array<Quest> | undefined {
    return this.snapshot ? this.response().quests : undefined;
  }

  /** An unknown id refetches only once the cache has expired, so it can't force GitHub calls. */
  public async findOrRefresh(id: string): Promise<Quest | undefined> {
    const cached = this.find(id);
    if (cached) {
      return cached;
    }
    await this.list();
    return this.find(id);
  }

  /**
   * Records a newer head commit for one cached quest, for example after an approval found the PR
   * had moved on. Costs no GitHub search, so it works during a rate-limit backoff too.
   */
  public async updateHeadSha(id: string, headSha: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot?.quests.some((quest) => quest.id === id)) {
      return;
    }
    this.snapshot = {
      ...snapshot,
      quests: snapshot.quests.map((quest) => (quest.id === id ? { ...quest, headSha } : quest)),
    };
    await this.persist();
    this.publish();
  }

  /** Hides a quest the player just approved or reviewed, and re-announces the queue. */
  public async markActedOn(id: string): Promise<void> {
    this.actedOn.set(id, this.now().getTime() + this.actedOnHoldMs);
    if (this.snapshot) {
      this.publish();
    }
  }

  /** The latest queue as an event, for clients that connect after it was broadcast. */
  public snapshotEvent(): ServerEvent | undefined {
    if (!this.snapshot) {
      return undefined;
    }
    return { type: 'questsUpdated', ...this.response() };
  }

  /**
   * Checks the queue now and then on an interval, refetching only when the cache has expired and
   * GitHub isn't rate limiting. Returns a function that stops polling.
   */
  public startPolling(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): () => void {
    this.polling = true;
    const tick = (): void => {
      this.list().catch((error: unknown) => this.logFailure(error));
    };
    tick();
    this.scheduleRetry();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => {
      this.polling = false;
      clearInterval(timer);
      clearTimeout(this.retryTimer);
    };
  }

  private async load(): Promise<ListQuestsResponse> {
    const { github, linear } = this.options;
    let requests: Awaited<ReturnType<typeof github.fetchReviewRequests>>;
    let linearInfo: Awaited<ReturnType<typeof linear.getReviewInfo>>;
    try {
      [requests, linearInfo] = await Promise.all([
        github.fetchReviewRequests(),
        linear.getReviewInfo(),
      ]);
    } catch (error) {
      if (error instanceof IncompleteQuestListError && this.snapshot) {
        this.options.log(
          `${error.message}; keeping the quests from ${this.snapshot.fetchedAt.toISOString()}`,
        );
        return this.response();
      }
      const kind = detectRateLimit(error);
      if (!kind) {
        throw error;
      }
      return this.enterBackoff(kind, rateLimitResetOf(error));
    }
    const quests = requests.map((request) =>
      toQuest({ ...request, linear: linear.lookup(linearInfo, request.item.url) }),
    );
    this.snapshot = {
      quests: sortQuests(quests),
      fetchedAt: this.now(),
      source: linearInfo ? 'linear' : 'github',
    };
    this.backoff = undefined;
    clearTimeout(this.retryTimer);
    await this.persist();
    const response = this.publish();
    // Only what GitHub's search returned counts toward Inbox Zero, not quests the board hides.
    await this.options.game.recordQueueChecked(quests.length).catch((error: unknown) => {
      this.options.log(`inbox check failed: ${errorMessage(error)}`);
    });
    return response;
  }

  /** `headerReset` comes from the failed response; `/rate_limit` fills it in for primary limits. */
  private async enterBackoff(
    kind: Backoff['kind'],
    headerReset: Date | undefined,
  ): Promise<ListQuestsResponse> {
    const resetAt =
      headerReset ??
      (kind === 'primary' ? await this.options.github.fetchRateLimitReset() : undefined);
    const backoff = nextBackoff({ kind, previous: this.backoff, now: this.now(), resetAt });
    this.backoff = backoff;
    this.options.log(
      `GitHub ${kind} rate limit; no quest refreshes until ${backoff.limitedUntil.toISOString()}`,
    );
    await this.persist();
    this.scheduleRetry();
    if (!this.snapshot) {
      throw new RateLimitedError(backoff);
    }
    return this.publish();
  }

  private cachedDuring(backoff: Backoff): ListQuestsResponse {
    if (!this.snapshot) {
      throw new RateLimitedError(backoff);
    }
    return this.response();
  }

  /** While polling, refreshes once the backoff ends instead of waiting for the next interval. */
  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    const backoff = this.activeBackoff();
    if (!this.polling || !backoff) {
      return;
    }
    const delay = backoff.limitedUntil.getTime() - this.now().getTime() + RETRY_MARGIN_MS;
    this.retryTimer = setTimeout(() => {
      this.refresh().catch((error: unknown) => this.logFailure(error));
    }, delay);
    this.retryTimer.unref();
  }

  private activeBackoff(): Backoff | undefined {
    return this.backoff && this.backoff.limitedUntil.getTime() > this.now().getTime()
      ? this.backoff
      : undefined;
  }

  private async persist(): Promise<void> {
    await this.options.cache
      ?.save({ snapshot: this.snapshot, backoff: this.backoff })
      .catch((error: unknown) => {
        this.options.log(`could not save the quest cache: ${errorMessage(error)}`);
      });
  }

  private publish(): ListQuestsResponse {
    const response = this.response();
    this.options.events.broadcast({ type: 'questsUpdated', ...response });
    return response;
  }

  private logFailure(error: unknown): void {
    if (!(error instanceof RateLimitedError)) {
      this.options.log(`quest refresh failed: ${errorMessage(error)}`);
    }
  }

  private response(): ListQuestsResponse {
    const snapshot = this.snapshot;
    if (!snapshot) {
      throw new Error('Quests have not been fetched yet');
    }
    const nowMs = this.now().getTime();
    for (const [id, until] of this.actedOn) {
      if (until <= nowMs) {
        this.actedOn.delete(id);
      }
    }
    const quests = snapshot.quests
      .filter((quest) => !this.actedOn.has(quest.id))
      .map((quest) => {
        const activeRunId = this.options.activeRunIdFor(quest.id);
        return activeRunId ? { ...quest, activeRunId } : quest;
      });
    const backoff = this.activeBackoff();
    const response: ListQuestsResponse = {
      quests,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      source: snapshot.source,
      stale: backoff !== undefined || nowMs - snapshot.fetchedAt.getTime() >= this.cacheTtlMs,
    };
    if (backoff) {
      response.rateLimit = { kind: backoff.kind, limitedUntil: backoff.limitedUntil.toISOString() };
    }
    return response;
  }
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
