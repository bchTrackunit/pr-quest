import type { ListQuestsResponse, Quest, QuestSource, ServerEvent } from '../shared/api.ts';
import type { EventSink, GameService } from './game.ts';
import { toQuest, type GitHubClient } from './github.ts';
import type { LinearReviewClient } from './linear.ts';
import { sortQuests } from './quests.ts';

const DEFAULT_MIN_REFRESH_MS = 15_000;
const DEFAULT_ACTED_ON_HOLD_MS = 5 * 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 2 * 60_000;

export interface QuestServiceOptions {
  github: Pick<GitHubClient, 'fetchReviewRequests'>;
  linear: Pick<LinearReviewClient, 'getReviewInfo' | 'lookup'>;
  events: EventSink;
  game: Pick<GameService, 'recordQueueChecked'>;
  activeRunIdFor: (questId: string) => string | undefined;
  log: (message: string) => void;
  now?: () => Date;
  /** `list()` serves the cache when it is younger than this. */
  minRefreshMs?: number;
  /**
   * How long a quest the player just approved or reviewed stays hidden. GitHub search lags behind
   * review submissions, so without this the quest would reappear on the next refresh.
   */
  actedOnHoldMs?: number;
}

interface QuestCache {
  quests: Array<Quest>;
  fetchedAt: Date;
  source: QuestSource;
}

/** The player's review queue: GitHub as the source of truth, Linear as optional enrichment. */
export class QuestService {
  private readonly options: QuestServiceOptions;
  private readonly now: () => Date;
  private readonly minRefreshMs: number;
  private readonly actedOnHoldMs: number;
  private readonly actedOn = new Map<string, number>();
  private cache?: QuestCache;
  private inFlight?: Promise<ListQuestsResponse>;

  public constructor(options: QuestServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS;
    this.actedOnHoldMs = options.actedOnHoldMs ?? DEFAULT_ACTED_ON_HOLD_MS;
  }

  public async list(options: { force?: boolean } = {}): Promise<ListQuestsResponse> {
    const fresh =
      this.cache && this.now().getTime() - this.cache.fetchedAt.getTime() < this.minRefreshMs;
    return !options.force && fresh ? this.response() : this.refresh();
  }

  /** Fetches the queue and broadcasts it; concurrent callers share one fetch. */
  public refresh(): Promise<ListQuestsResponse> {
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public find(id: string): Quest | undefined {
    return this.cache ? this.response().quests.find((quest) => quest.id === id) : undefined;
  }

  public async findOrRefresh(id: string): Promise<Quest | undefined> {
    const cached = this.find(id);
    if (cached) {
      return cached;
    }
    await this.refresh();
    return this.find(id);
  }

  /** Hides a quest the player just approved or reviewed, and re-announces the queue. */
  public async markActedOn(id: string): Promise<void> {
    this.actedOn.set(id, this.now().getTime() + this.actedOnHoldMs);
    if (this.cache) {
      await this.publish();
    }
  }

  /** The latest queue as an event, for clients that connect after it was broadcast. */
  public snapshotEvent(): ServerEvent | undefined {
    if (!this.cache) {
      return undefined;
    }
    return { type: 'questsUpdated', ...this.response() };
  }

  /** Refreshes now and then on an interval. Returns a function that stops polling. */
  public startPolling(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): () => void {
    const tick = (): void => {
      this.refresh().catch((error: unknown) => {
        this.options.log(
          `quest refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async load(): Promise<ListQuestsResponse> {
    const { github, linear } = this.options;
    const [requests, linearInfo] = await Promise.all([
      github.fetchReviewRequests(),
      linear.getReviewInfo(),
    ]);
    const quests = requests.map((request) =>
      toQuest({ ...request, linear: linear.lookup(linearInfo, request.item.url) }),
    );
    this.cache = {
      quests: sortQuests(quests),
      fetchedAt: this.now(),
      source: linearInfo ? 'linear' : 'github',
    };
    return this.publish();
  }

  private async publish(): Promise<ListQuestsResponse> {
    const response = this.response();
    this.options.events.broadcast({ type: 'questsUpdated', ...response });
    await this.options.game.recordQueueChecked(response.quests.length).catch((error: unknown) => {
      this.options.log(
        `inbox check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return response;
  }

  private response(): ListQuestsResponse {
    const cache = this.cache;
    if (!cache) {
      throw new Error('Quests have not been fetched yet');
    }
    const nowMs = this.now().getTime();
    for (const [id, until] of this.actedOn) {
      if (until <= nowMs) {
        this.actedOn.delete(id);
      }
    }
    const quests = cache.quests
      .filter((quest) => !this.actedOn.has(quest.id))
      .map((quest) => {
        const activeRunId = this.options.activeRunIdFor(quest.id);
        return activeRunId ? { ...quest, activeRunId } : quest;
      });
    return { quests, fetchedAt: cache.fetchedAt.toISOString(), source: cache.source };
  }
}
