import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Quest, ServerEvent } from '../shared/api.ts';
import { GhError } from './gh.ts';
import {
  parsePullRequestDetails,
  parseSearchResults,
  toQuest,
  type ReviewRequestData,
} from './github.ts';
import { LinearReviewClient, type LinearReviewInfo } from './linear.ts';
import type { CachedQuestState } from './questCache.ts';
import { QuestService, RateLimitedError, type QuestServiceOptions } from './questService.ts';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/gh/${name}`, import.meta.url), 'utf8');

const searchItems = parseSearchResults(fixture('search-all.json'));
const teamItem = searchItems.at(0);
const directItem = searchItems.at(1);
if (!teamItem || !directItem) {
  throw new Error('search fixture needs two items');
}
const REQUESTS: Array<ReviewRequestData> = [
  { item: teamItem, details: parsePullRequestDetails(fixture('pr-view-930.json')), direct: false },
  { item: directItem, details: parsePullRequestDetails(fixture('pr-view-24.json')), direct: true },
];

const SEARCH_LIMITED = new GhError(
  'HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/search/issues)',
  403,
);
const SECONDARY_LIMITED = new GhError(
  'gh: You have exceeded a secondary rate limit. Please wait a few minutes. (HTTP 403)',
  403,
);

let nowMs: number;
let events: Array<ServerEvent>;
let fetchReviewRequests: ReturnType<typeof vi.fn<() => Promise<Array<ReviewRequestData>>>>;
let fetchRateLimitReset: ReturnType<typeof vi.fn<() => Promise<Date | undefined>>>;
let linearInfo: Map<string, LinearReviewInfo> | undefined;
let recordQueueChecked: ReturnType<typeof vi.fn<(count: number) => Promise<void>>>;
let logs: Array<string>;

/** An in-memory stand-in for `QuestCache`. */
function memoryCache(initial: CachedQuestState = {}) {
  let stored = initial;
  return {
    load: vi.fn(async () => stored),
    save: vi.fn(async (state: CachedQuestState) => {
      stored = state;
    }),
    get stored() {
      return stored;
    },
  };
}

const cachedQuests = (): Array<Quest> => REQUESTS.map((request) => toQuest(request));

function service(overrides: Partial<QuestServiceOptions> = {}): QuestService {
  const linear = new LinearReviewClient();
  return new QuestService({
    github: { fetchReviewRequests, fetchRateLimitReset },
    linear: { getReviewInfo: async () => linearInfo, lookup: linear.lookup.bind(linear) },
    events: { broadcast: (event) => events.push(event) },
    game: { recordQueueChecked },
    activeRunIdFor: () => undefined,
    log: (message) => logs.push(message),
    now: () => new Date(nowMs),
    ...overrides,
  });
}

beforeEach(() => {
  nowMs = Date.parse('2026-10-30T14:00:00.000Z');
  events = [];
  logs = [];
  linearInfo = undefined;
  fetchReviewRequests = vi.fn(async () => REQUESTS);
  fetchRateLimitReset = vi.fn(async () => new Date('2026-10-30T14:00:45.000Z'));
  recordQueueChecked = vi.fn(async () => undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QuestService.refresh', () => {
  test('lists direct requests first and reports GitHub as the source without Linear', async () => {
    const response = await service().refresh();

    expect(response.quests.map((quest) => quest.id)).toEqual([
      'Trackunit/state-of-code#24',
      'Trackunit/circleci-configuration#930',
    ]);
    expect(response).toMatchObject({
      source: 'github',
      fetchedAt: '2026-10-30T14:00:00.000Z',
      stale: false,
    });
    expect(response).not.toHaveProperty('rateLimit');
  });

  test('adds the Linear review link and attention flag when Linear is available', async () => {
    linearInfo = new Map([
      [
        'https://github.com/trackunit/circleci-configuration/pull/930',
        { appUrl: 'https://linear.app/t/review/x', needsAttention: true },
      ],
    ]);

    const response = await service().refresh();

    expect(response.source).toBe('linear');
    expect(response.quests.find((quest) => quest.number === 930)).toMatchObject({
      linearUrl: 'https://linear.app/t/review/x',
      needsAttention: true,
      source: 'linear',
    });
    expect(response.quests.find((quest) => quest.number === 24)?.source).toBe('github');
  });

  test('broadcasts the quests with their source and checks the queue for Inbox Zero', async () => {
    await service().refresh();

    expect(events).toEqual([
      expect.objectContaining({
        type: 'questsUpdated',
        fetchedAt: '2026-10-30T14:00:00.000Z',
        source: 'github',
      }),
    ]);
    expect(recordQueueChecked).toHaveBeenCalledWith(2);
  });

  test('replays the latest quests with their source to late subscribers', async () => {
    const quests = service();
    expect(quests.snapshotEvent()).toBeUndefined();

    await quests.refresh();

    expect(quests.snapshotEvent()).toMatchObject({ type: 'questsUpdated', source: 'github' });
  });

  test('marks the active run on its quest', async () => {
    const response = await service({
      activeRunIdFor: (questId) =>
        questId === 'Trackunit/state-of-code#24' ? 'review-1' : undefined,
    }).refresh();

    expect(response.quests[0]?.activeRunId).toBe('review-1');
    expect(response.quests[1]).not.toHaveProperty('activeRunId');
  });

  test('shares one fetch between concurrent refreshes', async () => {
    const quests = service();

    await Promise.all([quests.refresh(), quests.refresh()]);

    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);
  });
});

describe('QuestService.list', () => {
  test('serves the cache for 60 seconds by default and refetches after', async () => {
    const quests = service();
    await quests.list();

    nowMs += 59_999;
    await quests.list();
    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await quests.list();
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
  });

  test('marks the quests stale once they outlive the cache lifetime', async () => {
    const quests = service({ cacheTtlMs: 10_000 });
    await quests.refresh();

    nowMs += 10_000;

    expect(quests.snapshotEvent()).toMatchObject({ stale: true });
  });

  test('refetches when forced', async () => {
    const quests = service();
    await quests.list();

    await quests.list({ force: true });

    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
  });
});

describe('QuestService.markActedOn', () => {
  test('hides the quest right away and across refreshes until the hold expires', async () => {
    const quests = service({ actedOnHoldMs: 60_000 });
    await quests.refresh();
    events = [];

    await quests.markActedOn('Trackunit/state-of-code#24');

    expect(events).toEqual([expect.objectContaining({ type: 'questsUpdated' })]);
    expect((await quests.list()).quests.map((quest) => quest.number)).toEqual([930]);
    expect((await quests.refresh()).quests.map((quest) => quest.number)).toEqual([930]);
    expect(recordQueueChecked).toHaveBeenLastCalledWith(1);

    nowMs += 60_000;
    expect((await quests.refresh()).quests.map((quest) => quest.number)).toEqual([24, 930]);
  });
});

describe('QuestService.findOrRefresh', () => {
  test('uses the cache, then refreshes once for unknown ids', async () => {
    const quests = service();
    await quests.refresh();

    await expect(quests.findOrRefresh('Trackunit/state-of-code#24')).resolves.toMatchObject({
      number: 24,
    });
    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);

    await expect(quests.findOrRefresh('Trackunit/manager#1')).resolves.toBeUndefined();
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
  });
});

describe('QuestService.startPolling', () => {
  test('refreshes on an interval and logs failures instead of throwing', async () => {
    vi.useFakeTimers();
    fetchReviewRequests.mockRejectedValueOnce(new Error('gh: HTTP 502'));
    const quests = service();

    const stop = quests.startPolling(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(logs.join('\n')).toContain('gh: HTTP 502');

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
  });

  test('skips polls while the cache is fresh', async () => {
    vi.useFakeTimers();
    const quests = service({ cacheTtlMs: 60_000 });

    const stop = quests.startPolling(30_000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
    stop();
  });

  test('retries once the backoff ends instead of waiting for the next poll', async () => {
    vi.useFakeTimers({ now: nowMs });
    fetchReviewRequests.mockRejectedValueOnce(SECONDARY_LIMITED);
    const quests = service({
      cache: memoryCache({ snapshot: staleSnapshot() }),
      now: () => new Date(),
    });
    await quests.restore();

    const stop = quests.startPolling(10 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toContain('secondary rate limit');

    await vi.advanceTimersByTimeAsync(60_000 + 1000);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
    expect(quests.snapshotEvent()).not.toHaveProperty('rateLimit');
    stop();
  });
});

function staleSnapshot(): NonNullable<CachedQuestState['snapshot']> {
  return {
    quests: cachedQuests(),
    fetchedAt: new Date(nowMs - 5 * 60_000),
    source: 'github',
  };
}

describe('QuestService cache on disk', () => {
  test('serves fresh cached quests on startup without calling GitHub', async () => {
    const cache = memoryCache({
      snapshot: { quests: cachedQuests(), fetchedAt: new Date(nowMs - 30_000), source: 'github' },
    });
    const quests = service({ cache });

    await quests.restore();
    const response = await quests.list();

    expect(fetchReviewRequests).not.toHaveBeenCalled();
    expect(response).toMatchObject({ fetchedAt: '2026-10-30T13:59:30.000Z', stale: false });
    expect(response.quests.map((quest) => quest.number)).toEqual([930, 24]);
    expect(quests.snapshotEvent()).toMatchObject({ type: 'questsUpdated' });
  });

  test('polling at startup does not refetch a fresh cache', async () => {
    vi.useFakeTimers();
    const cache = memoryCache({
      snapshot: { quests: cachedQuests(), fetchedAt: new Date(nowMs - 30_000), source: 'github' },
    });
    const quests = service({ cache });
    await quests.restore();

    const stop = quests.startPolling(1000);
    await vi.advanceTimersByTimeAsync(0);
    stop();

    expect(fetchReviewRequests).not.toHaveBeenCalled();
  });

  test('refetches a cache older than its lifetime and saves the result', async () => {
    const cache = memoryCache({ snapshot: staleSnapshot() });
    const quests = service({ cache });
    await quests.restore();

    expect(quests.snapshotEvent()).toMatchObject({ stale: true });
    await quests.list();

    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);
    expect(cache.stored.snapshot?.fetchedAt).toEqual(new Date(nowMs));
    expect(cache.stored.backoff).toBeUndefined();
  });

  test('keeps working when the cache cannot be saved', async () => {
    const cache = memoryCache();
    cache.save.mockRejectedValue(new Error('disk full'));

    await expect(service({ cache }).refresh()).resolves.toMatchObject({ stale: false });
    expect(logs.join('\n')).toContain('disk full');
  });
});

describe('QuestService rate limits', () => {
  async function limitedService(error: Error = SEARCH_LIMITED) {
    const cache = memoryCache({ snapshot: staleSnapshot() });
    const quests = service({ cache });
    await quests.restore();
    fetchReviewRequests.mockRejectedValueOnce(error);
    return { quests, cache };
  }

  test('serves the cached quests with the rate limit instead of failing', async () => {
    const { quests } = await limitedService();

    const response = await quests.refresh();

    expect(response).toMatchObject({
      stale: true,
      rateLimit: { kind: 'primary', limitedUntil: '2026-10-30T14:00:47.000Z' },
    });
    expect(response.quests).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({ type: 'questsUpdated', rateLimit: expect.any(Object) }),
    ]);
    expect(recordQueueChecked).not.toHaveBeenCalled();
  });

  test('reads the primary reset from gh api rate_limit but not for secondary limits', async () => {
    const primary = await limitedService();
    await primary.quests.refresh();
    expect(fetchRateLimitReset).toHaveBeenCalledTimes(1);

    fetchRateLimitReset.mockClear();
    const secondary = await limitedService(SECONDARY_LIMITED);
    const response = await secondary.quests.refresh();

    expect(fetchRateLimitReset).not.toHaveBeenCalled();
    expect(response.rateLimit).toEqual({
      kind: 'secondary',
      limitedUntil: '2026-10-30T14:01:00.000Z',
    });
  });

  test('makes no GitHub calls during the backoff, even when forced', async () => {
    const { quests } = await limitedService();
    await quests.refresh();

    nowMs += 30_000;
    const forced = await quests.list({ force: true });
    await quests.refresh();
    await quests.findOrRefresh('Trackunit/manager#1');

    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);
    expect(forced.rateLimit?.kind).toBe('primary');
  });

  test('fetches again after the backoff and clears the rate limit on success', async () => {
    const { quests, cache } = await limitedService();
    await quests.refresh();
    expect(cache.stored.backoff?.kind).toBe('primary');

    nowMs = Date.parse('2026-10-30T14:00:47.000Z');
    const response = await quests.list({ force: true });

    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({ stale: false });
    expect(response).not.toHaveProperty('rateLimit');
    expect(cache.stored.backoff).toBeUndefined();
  });

  test('doubles the backoff on consecutive limits', async () => {
    fetchRateLimitReset.mockResolvedValue(undefined);
    const { quests } = await limitedService(SECONDARY_LIMITED);
    await quests.refresh();

    nowMs += 60_000;
    fetchReviewRequests.mockRejectedValueOnce(SECONDARY_LIMITED);
    const second = await quests.refresh();

    expect(second.rateLimit?.limitedUntil).toBe('2026-10-30T14:03:00.000Z');
  });

  test('rejects with RateLimitedError when there is nothing cached yet', async () => {
    fetchReviewRequests.mockRejectedValue(SECONDARY_LIMITED);
    const quests = service();

    await expect(quests.refresh()).rejects.toBeInstanceOf(RateLimitedError);
    await expect(quests.list({ force: true })).rejects.toBeInstanceOf(RateLimitedError);
    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  test('honours a backoff restored from disk after a restart', async () => {
    const cache = memoryCache({
      snapshot: staleSnapshot(),
      backoff: {
        kind: 'secondary',
        limitedUntil: new Date(nowMs + 120_000),
        attempt: 2,
      },
    });
    const quests = service({ cache });
    await quests.restore();

    const response = await quests.list();

    expect(fetchReviewRequests).not.toHaveBeenCalled();
    expect(response.rateLimit).toEqual({
      kind: 'secondary',
      limitedUntil: '2026-10-30T14:02:00.000Z',
    });
  });

  test('still throws errors that are not rate limits', async () => {
    const { quests } = await limitedService(new GhError('gh: Bad credentials (HTTP 401)', 401));

    await expect(quests.refresh()).rejects.toThrow('Bad credentials');
    expect(quests.snapshotEvent()).not.toHaveProperty('rateLimit');
  });
});
