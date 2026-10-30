import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '../shared/api.ts';
import { parsePullRequestDetails, parseSearchResults, type ReviewRequestData } from './github.ts';
import { LinearReviewClient, type LinearReviewInfo } from './linear.ts';
import { QuestService, type QuestServiceOptions } from './questService.ts';

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

let nowMs: number;
let events: Array<ServerEvent>;
let fetchReviewRequests: ReturnType<typeof vi.fn<() => Promise<Array<ReviewRequestData>>>>;
let linearInfo: Map<string, LinearReviewInfo> | undefined;
let recordQueueChecked: ReturnType<typeof vi.fn<(count: number) => Promise<void>>>;
let logs: Array<string>;

function service(overrides: Partial<QuestServiceOptions> = {}): QuestService {
  const linear = new LinearReviewClient();
  return new QuestService({
    github: { fetchReviewRequests },
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
    expect(response).toMatchObject({ source: 'github', fetchedAt: '2026-10-30T14:00:00.000Z' });
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

  test('broadcasts the quests and checks the queue for Inbox Zero', async () => {
    await service().refresh();

    expect(events).toEqual([
      expect.objectContaining({ type: 'questsUpdated', fetchedAt: '2026-10-30T14:00:00.000Z' }),
    ]);
    expect(recordQueueChecked).toHaveBeenCalledWith(2);
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
  test('serves the cache while it is fresh and refetches after', async () => {
    const quests = service({ minRefreshMs: 15_000 });
    await quests.list();

    nowMs += 14_999;
    await quests.list();
    expect(fetchReviewRequests).toHaveBeenCalledTimes(1);

    nowMs += 1;
    await quests.list();
    expect(fetchReviewRequests).toHaveBeenCalledTimes(2);
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
});
