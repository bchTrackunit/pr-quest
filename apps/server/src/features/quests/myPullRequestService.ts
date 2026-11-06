import type {
  ListMyPullRequestsResponse,
  MyPullRequest,
  ServerEvent,
} from '@pr-quest/contract/api';
import type { AuthorObservation, EventSink, GameService } from '../game/index.ts';
import type { AuthoredPullRequests, GitHubClient } from './github.ts';
import type { MyPullRequestCache, MyPullRequestSnapshot } from './myPullRequestCache.ts';
import { authorObservationsOf, sortMyPullRequests, toMyPullRequest } from './myPullRequests.ts';
import {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  RateLimitedError,
} from './questService.ts';
import { GitHubApiError } from '../../platform/githubApi.ts';
import {
  detectRateLimit,
  nextBackoff,
  rateLimitResetOf,
  type Backoff,
} from '../../platform/rateLimit.ts';

/** Merged and closed PRs are read back this far past the last sync, for clock differences. */
export const SYNC_OVERLAP_MS = 10 * 60_000;
const RETRY_MARGIN_MS = 1000;

export interface MyPullRequestServiceOptions {
  github: Pick<GitHubClient, 'fetchMyPullRequests' | 'fetchRateLimitReset'>;
  events: EventSink;
  game: Pick<GameService, 'authorSyncPoint' | 'recordAuthorActivity'>;
  activeRunIdFor: (prId: string) => string | undefined;
  log: (message: string) => void;
  now?: () => Date;
  cache?: Pick<MyPullRequestCache, 'load' | 'save'>;
  cacheTtlMs?: number;
}

/**
 * The player's open PRs, refreshed the way the review board is: cached on disk, polled, and not
 * fetched at all while GitHub rate limits us. Each read also reports author activity to the game.
 */
export class MyPullRequestService {
  private readonly options: MyPullRequestServiceOptions;
  private readonly now: () => Date;
  private readonly cacheTtlMs: number;
  private snapshot?: MyPullRequestSnapshot;
  private backoff?: Backoff;
  private inFlight?: Promise<ListMyPullRequestsResponse>;
  private polling = false;
  private retryTimer?: NodeJS.Timeout;

  public constructor(options: MyPullRequestServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  public async restore(): Promise<void> {
    const cached = await this.options.cache?.load();
    this.snapshot ??= cached?.snapshot;
    this.backoff ??= cached?.backoff;
  }

  public async list(options: { force?: boolean } = {}): Promise<ListMyPullRequestsResponse> {
    const fresh =
      this.snapshot && this.now().getTime() - this.snapshot.fetchedAt.getTime() < this.cacheTtlMs;
    return !options.force && fresh ? this.response() : this.refresh();
  }

  /** Concurrent callers share one fetch; during a backoff no GitHub call is made. */
  public async refresh(): Promise<ListMyPullRequestsResponse> {
    const backoff = this.activeBackoff();
    if (backoff) {
      if (!this.snapshot) {
        throw new RateLimitedError(backoff);
      }
      return this.response();
    }
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  public find(id: string): MyPullRequest | undefined {
    return this.snapshot ? this.response().pullRequests.find((pr) => pr.id === id) : undefined;
  }

  /** An unknown id refetches only once the cache has expired, so it can't force GitHub calls. */
  public async findOrRefresh(id: string): Promise<MyPullRequest | undefined> {
    const cached = this.find(id);
    if (cached) {
      return cached;
    }
    await this.list();
    return this.find(id);
  }

  public snapshotEvent(): ServerEvent | undefined {
    return this.snapshot ? { type: 'myPullRequestsUpdated', ...this.response() } : undefined;
  }

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

  private async load(): Promise<ListMyPullRequestsResponse> {
    const startedAt = this.now();
    const lastSync = this.options.game.authorSyncPoint();
    const since = new Date(
      (lastSync ? Date.parse(lastSync) : startedAt.getTime()) - SYNC_OVERLAP_MS,
    );
    let read: AuthoredPullRequests;
    try {
      read = await this.options.github.fetchMyPullRequests(since);
    } catch (error) {
      const kind = detectRateLimit(error);
      if (!kind) {
        throw error;
      }
      return this.enterBackoff(kind, rateLimitResetOf(error));
    }
    this.backoff = undefined;
    clearTimeout(this.retryTimer);
    await this.recordActivity(read, startedAt);

    const openTotal = read.open.length + read.openSkipped;
    if (read.openSkipped * 2 > openTotal) {
      const message = `Could not read ${read.openSkipped} of ${openTotal} of your PRs from GitHub`;
      if (!this.snapshot) {
        throw new GitHubApiError(message);
      }
      this.options.log(
        `${message}; keeping the list from ${this.snapshot.fetchedAt.toISOString()}`,
      );
      await this.persist();
      return this.response();
    }
    this.snapshot = {
      pullRequests: sortMyPullRequests(read.open.map(toMyPullRequest)),
      fetchedAt: this.now(),
    };
    await this.persist();
    return this.publish();
  }

  /**
   * The sync point moves to when this read started, unless reading merged and closed PRs hit an
   * error that may clear up; then those PRs are read again next time.
   */
  private async recordActivity(read: AuthoredPullRequests, startedAt: Date): Promise<void> {
    const prs = [...read.open, ...read.done];
    const observations: Array<AuthorObservation> = prs.flatMap((pr) =>
      authorObservationsOf(pr, read.viewerLogin),
    );
    const holdSync = read.doneErrors > 0;
    if (holdSync) {
      this.options.log(
        `GitHub returned ${read.doneErrors} errors reading your merged and closed PRs; they will be read again`,
      );
    }
    await this.options.game
      .recordAuthorActivity({
        observations,
        readPrs: prs.map((pr) => pr.id),
        readAt: startedAt.toISOString(),
        ...(holdSync ? {} : { lastAuthorSync: startedAt.toISOString() }),
      })
      .catch((error: unknown) => {
        this.options.log(`author XP failed: ${errorMessage(error)}`);
      });
  }

  private async enterBackoff(
    kind: Backoff['kind'],
    headerReset: Date | undefined,
  ): Promise<ListMyPullRequestsResponse> {
    const resetAt =
      headerReset ??
      (kind === 'primary' ? await this.options.github.fetchRateLimitReset() : undefined);
    const backoff = nextBackoff({ kind, previous: this.backoff, now: this.now(), resetAt });
    this.backoff = backoff;
    this.options.log(
      `GitHub ${kind} rate limit; no My PRs refreshes until ${backoff.limitedUntil.toISOString()}`,
    );
    await this.persist();
    this.scheduleRetry();
    if (!this.snapshot) {
      throw new RateLimitedError(backoff);
    }
    return this.publish();
  }

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
        this.options.log(`could not save the My PRs cache: ${errorMessage(error)}`);
      });
  }

  private publish(): ListMyPullRequestsResponse {
    const response = this.response();
    this.options.events.broadcast({ type: 'myPullRequestsUpdated', ...response });
    return response;
  }

  private logFailure(error: unknown): void {
    if (!(error instanceof RateLimitedError)) {
      this.options.log(`My PRs refresh failed: ${errorMessage(error)}`);
    }
  }

  private response(): ListMyPullRequestsResponse {
    const snapshot = this.snapshot;
    if (!snapshot) {
      throw new Error('Your PRs have not been fetched yet');
    }
    const nowMs = this.now().getTime();
    const backoff = this.activeBackoff();
    const response: ListMyPullRequestsResponse = {
      pullRequests: snapshot.pullRequests.map((pr) => {
        const activeRunId = this.options.activeRunIdFor(pr.id);
        return activeRunId ? { ...pr, activeRunId } : pr;
      }),
      fetchedAt: snapshot.fetchedAt.toISOString(),
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
