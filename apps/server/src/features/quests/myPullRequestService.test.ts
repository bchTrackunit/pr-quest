import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '@pr-quest/contract/api';
import type { AuthorActivity } from '../game/index.ts';
import { GitHubApiError } from '../../platform/githubApi.ts';
import type { AuthoredPullRequests } from './github.ts';
import type { CachedMyPullRequestState } from './myPullRequestCache.ts';
import {
  MyPullRequestService,
  SYNC_OVERLAP_MS,
  type MyPullRequestServiceOptions,
} from './myPullRequestService.ts';
import { RateLimitedError } from './questService.ts';
import { authoredPullRequests } from './test-utils/fixtures.ts';

const LIMITED = new GitHubApiError('API rate limit exceeded (HTTP 403)', {
  httpStatus: 403,
  rateLimit: { kind: 'primary', resetAt: new Date('2026-10-30T14:30:00.000Z') },
});

let nowMs: number;
let events: Array<ServerEvent>;
let logs: Array<string>;
let fetchMyPullRequests: ReturnType<typeof vi.fn<(since: Date) => Promise<AuthoredPullRequests>>>;
let recordAuthorActivity: ReturnType<typeof vi.fn<(activity: AuthorActivity) => Promise<never>>>;
let lastAuthorSync: string | undefined;

function memoryCache(initial: CachedMyPullRequestState = {}) {
  let stored = initial;
  return {
    load: vi.fn(async () => stored),
    save: vi.fn(async (state: CachedMyPullRequestState) => {
      stored = state;
    }),
    get stored() {
      return stored;
    },
  };
}

function service(overrides: Partial<MyPullRequestServiceOptions> = {}): MyPullRequestService {
  return new MyPullRequestService({
    github: { fetchMyPullRequests, fetchRateLimitReset: async () => undefined },
    events: { broadcast: (event) => events.push(event) },
    game: { authorSyncPoint: () => lastAuthorSync, recordAuthorActivity },
    activeRunIdFor: (id) => (id === 'Trackunit/state-of-code#41' ? 'run-7' : undefined),
    log: (message) => logs.push(message),
    now: () => new Date(nowMs),
    ...overrides,
  });
}

const activityOf = (call = 0): AuthorActivity | undefined =>
  recordAuthorActivity.mock.calls[call]?.[0];

beforeEach(() => {
  nowMs = Date.parse('2026-10-30T14:00:00.000Z');
  events = [];
  logs = [];
  lastAuthorSync = undefined;
  fetchMyPullRequests = vi.fn(async () => authoredPullRequests());
  // The service never reads the outcome, so the fake rejects; the service only logs that.
  recordAuthorActivity = vi.fn(async (_activity: AuthorActivity): Promise<never> => {
    throw new Error('unused');
  });
});

describe('MyPullRequestService.refresh', () => {
  test('lists the open PRs in order, with active runs, and broadcasts them', async () => {
    const response = await service().refresh();

    expect(response.pullRequests.map((pr) => pr.number)).toEqual([40, 42, 7, 41]);
    expect(response.pullRequests.find((pr) => pr.number === 41)?.activeRunId).toBe('run-7');
    expect(response).toMatchObject({ fetchedAt: '2026-10-30T14:00:00.000Z', stale: false });
    expect(events.at(-1)).toMatchObject({ type: 'myPullRequestsUpdated' });
  });

  test('reads merged and closed PRs back to ten minutes before the last sync', async () => {
    lastAuthorSync = '2026-10-30T12:00:00.000Z';

    await service().refresh();

    expect(fetchMyPullRequests).toHaveBeenCalledWith(
      new Date(Date.parse('2026-10-30T12:00:00.000Z') - SYNC_OVERLAP_MS),
    );
  });

  test('without a sync yet, reads only the last ten minutes of merged and closed PRs', async () => {
    await service().refresh();

    expect(fetchMyPullRequests).toHaveBeenCalledWith(new Date(nowMs - SYNC_OVERLAP_MS));
  });

  test('reports every PR read and moves the sync point to when the read started', async () => {
    await service().refresh();

    const activity = activityOf();
    expect(activity?.readPrs).toEqual([
      'Trackunit/state-of-code#40',
      'Trackunit/state-of-code#41',
      'Trackunit/state-of-code#42',
      'Trackunit/handbook#7',
      'Trackunit/state-of-code#35',
      'Trackunit/state-of-code#33',
    ]);
    expect(activity?.lastAuthorSync).toBe('2026-10-30T14:00:00.000Z');
    expect(activity?.readAt).toBe('2026-10-30T14:00:00.000Z');
    expect(activity?.observations.filter((entry) => entry.kind === 'merged')).toHaveLength(1);
  });

  test('holds the sync point when merged and closed PRs had errors that may clear up', async () => {
    fetchMyPullRequests.mockResolvedValue({ ...authoredPullRequests(), doneErrors: 1 });

    await service().refresh();

    expect(activityOf()).not.toHaveProperty('lastAuthorSync');
    expect(logs.some((line) => line.includes('read again'))).toBe(true);
  });

  test('moves the sync point past PRs GitHub will never let PR Quest read', async () => {
    fetchMyPullRequests.mockResolvedValue({ ...authoredPullRequests(), doneSkipped: 2 });

    await service().refresh();

    expect(activityOf()?.lastAuthorSync).toBe('2026-10-30T14:00:00.000Z');
  });

  test('drops a PR that could not be read and keeps the rest', async () => {
    const response = await service().refresh();

    expect(response.pullRequests).toHaveLength(4);
  });

  test('keeps the previous list when most PRs could not be read', async () => {
    const quests = service();
    await quests.refresh();
    nowMs += 5 * 60_000;
    const read = authoredPullRequests();
    fetchMyPullRequests.mockResolvedValue({ ...read, open: read.open.slice(0, 1), openSkipped: 4 });

    const response = await quests.refresh();

    expect(response.pullRequests).toHaveLength(4);
    expect(response.fetchedAt).toBe('2026-10-30T14:00:00.000Z');
    expect(logs.some((line) => line.includes('Could not read 4 of 5'))).toBe(true);
  });

  test('fails when most PRs could not be read and there is no list to keep', async () => {
    const read = authoredPullRequests();
    fetchMyPullRequests.mockResolvedValue({ ...read, open: [], openSkipped: 3 });

    await expect(service().refresh()).rejects.toThrow('Could not read 3 of 3');
  });

  test('a failed read reports no author activity', async () => {
    fetchMyPullRequests.mockRejectedValue(new GitHubApiError('boom'));

    await expect(service().refresh()).rejects.toThrow('boom');
    expect(recordAuthorActivity).not.toHaveBeenCalled();
  });

  test('a failing game update is logged, and the list still loads', async () => {
    const response = await service().refresh();

    expect(response.pullRequests).toHaveLength(4);
    expect(logs).toContain('author XP failed: unused');
  });
});

describe('MyPullRequestService caching and rate limits', () => {
  test('serves the cache while it is fresh, and refetches when forced', async () => {
    const quests = service();
    await quests.list();
    await quests.list();
    expect(fetchMyPullRequests).toHaveBeenCalledTimes(1);

    await quests.list({ force: true });

    expect(fetchMyPullRequests).toHaveBeenCalledTimes(2);
  });

  test('restores the cached list after a restart without calling GitHub', async () => {
    const cache = memoryCache();
    await service({ cache }).refresh();

    const restarted = service({ cache });
    await restarted.restore();

    expect(restarted.snapshotEvent()).toMatchObject({ type: 'myPullRequestsUpdated' });
    expect(cache.stored.snapshot?.pullRequests[0]).not.toHaveProperty('activeRunId');
    expect(fetchMyPullRequests).toHaveBeenCalledTimes(1);
  });

  test('a rate limit serves the cached list as stale, with the limit, and calls nothing', async () => {
    const quests = service();
    await quests.refresh();
    nowMs += 5 * 60_000;
    fetchMyPullRequests.mockRejectedValue(LIMITED);

    const limited = await quests.refresh();
    const again = await quests.refresh();

    expect(limited).toMatchObject({
      stale: true,
      rateLimit: { kind: 'primary', limitedUntil: '2026-10-30T14:30:02.000Z' },
    });
    expect(again.rateLimit).toBeDefined();
    expect(fetchMyPullRequests).toHaveBeenCalledTimes(2);
  });

  test('a rate limit with nothing cached rejects with RateLimitedError', async () => {
    fetchMyPullRequests.mockRejectedValue(LIMITED);

    await expect(service().refresh()).rejects.toBeInstanceOf(RateLimitedError);
  });

  test('finds a listed PR, and an unknown one only after refetching an expired cache', async () => {
    const quests = service();
    await quests.refresh();

    expect(quests.find('Trackunit/state-of-code#40')?.title).toBe(
      'feat(widgets): add the widget list',
    );
    expect(await quests.findOrRefresh('o/r#999')).toBeUndefined();
    expect(fetchMyPullRequests).toHaveBeenCalledTimes(1);
  });
});
