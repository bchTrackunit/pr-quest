import { describe, expect, test } from 'vitest';

import { makeMyPullRequest } from '../../platform/test-utils/fixtures.ts';
import { loadView, saveView, VIEW_STORAGE_KEY, type StorageLike } from './boardViewStorage.ts';
import {
  countNeedingMyAction,
  DEFAULT_MY_PR_FILTERS,
  DEFAULT_MY_PR_VIEW,
  filterMyPullRequests,
  loadMyPrView,
  MY_PRS_VIEW_STORAGE_KEY,
  saveMyPrView,
  sortMyPullRequests,
} from './myPrFilters.ts';
import { DEFAULT_VIEW } from './questFilters.ts';

function memoryStorage(): StorageLike & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

const waitingOld = makeMyPullRequest({ number: 1, openedAt: '2026-10-01T10:00:00.000Z' });
const approved = makeMyPullRequest({
  number: 2,
  reviewState: 'approved',
  openedAt: '2026-09-01T10:00:00.000Z',
});
const needsNew = makeMyPullRequest({
  number: 3,
  reviewState: 'changesRequested',
  needsMyAction: true,
  openedAt: '2026-10-20T10:00:00.000Z',
});
const needsOld = makeMyPullRequest({
  number: 4,
  unresolvedThreads: 2,
  needsMyAction: true,
  openedAt: '2026-10-10T10:00:00.000Z',
});
const draft = makeMyPullRequest({
  number: 5,
  isDraft: true,
  difficulty: 'Boss',
  title: 'Rewrite the router',
  openedAt: '2026-10-15T10:00:00.000Z',
});

describe('sortMyPullRequests', () => {
  test('the default order: needs my action, then waiting on others, then the rest, oldest first', () => {
    const sorted = sortMyPullRequests([waitingOld, approved, needsNew, needsOld, draft], {
      mode: 'smart',
      direction: 'asc',
    });
    expect(sorted.map((pr) => pr.number)).toEqual([4, 3, 1, 5, 2]);
  });

  test('sorts by age when asked, newest first', () => {
    const sorted = sortMyPullRequests([waitingOld, approved, needsNew], {
      mode: 'created',
      direction: 'desc',
    });
    expect(sorted.map((pr) => pr.number)).toEqual([3, 1, 2]);
  });
});

describe('filterMyPullRequests', () => {
  const all = [waitingOld, needsNew, draft];

  test('hides drafts', () => {
    const shown = filterMyPullRequests(all, { ...DEFAULT_MY_PR_FILTERS, hideDrafts: true });
    expect(shown.map((pr) => pr.number)).toEqual([1, 3]);
  });

  test('shows only PRs that need my action', () => {
    const shown = filterMyPullRequests(all, { ...DEFAULT_MY_PR_FILTERS, needsMyAction: true });
    expect(shown.map((pr) => pr.number)).toEqual([3]);
  });

  test('filters by tier and searches title and #number', () => {
    expect(
      filterMyPullRequests(all, { ...DEFAULT_MY_PR_FILTERS, tiers: ['Boss'] }).map(
        (pr) => pr.number,
      ),
    ).toEqual([5]);
    expect(
      filterMyPullRequests(all, { ...DEFAULT_MY_PR_FILTERS, search: 'router' }).map(
        (pr) => pr.number,
      ),
    ).toEqual([5]);
    expect(
      filterMyPullRequests(all, { ...DEFAULT_MY_PR_FILTERS, search: '#3' }).map((pr) => pr.number),
    ).toEqual([3]);
  });
});

test('countNeedingMyAction counts changes requested and unresolved threads', () => {
  expect(countNeedingMyAction([waitingOld, needsNew, needsOld, draft])).toBe(2);
});

describe('My PRs view storage', () => {
  test('is kept apart from the review board view', () => {
    const storage = memoryStorage();
    saveView(storage, {
      ...DEFAULT_VIEW,
      filters: { ...DEFAULT_VIEW.filters, search: 'board' },
    });
    saveMyPrView(storage, {
      ...DEFAULT_MY_PR_VIEW,
      filters: { ...DEFAULT_MY_PR_FILTERS, search: 'mine', hideDrafts: true },
    });

    expect(storage.items.has(VIEW_STORAGE_KEY)).toBe(true);
    expect(storage.items.has(MY_PRS_VIEW_STORAGE_KEY)).toBe(true);
    expect(loadView(storage).filters.search).toBe('board');
    expect(loadMyPrView(storage).filters).toEqual({
      ...DEFAULT_MY_PR_FILTERS,
      search: 'mine',
      hideDrafts: true,
    });
  });

  test('falls back per field on bad values and to the defaults on bad JSON', () => {
    const storage = memoryStorage();
    storage.setItem(
      MY_PRS_VIEW_STORAGE_KEY,
      JSON.stringify({ filters: { needsMyAction: true, tiers: ['Legendary'] }, sort: 'x' }),
    );
    expect(loadMyPrView(storage)).toEqual({
      filters: { ...DEFAULT_MY_PR_FILTERS, needsMyAction: true },
      sort: DEFAULT_MY_PR_VIEW.sort,
    });

    storage.setItem(MY_PRS_VIEW_STORAGE_KEY, '{not json');
    expect(loadMyPrView(storage)).toEqual(DEFAULT_MY_PR_VIEW);
    expect(loadMyPrView(undefined)).toEqual(DEFAULT_MY_PR_VIEW);
  });
});
