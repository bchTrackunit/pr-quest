import { z } from 'zod';

import type { DifficultyTier, MyPullRequest } from '@pr-quest/contract/api';
import type { StorageLike } from './boardViewStorage.ts';
import { DEFAULT_SORT, matchesSearch, questSize, type QuestSort } from './questFilters.ts';

/** Separate from the review board's, so each tab keeps its own settings. */
export const MY_PRS_VIEW_STORAGE_KEY = 'pr-quest:my-prs-view:v1';
const MAX_SEARCH_LENGTH = 200;

export interface MyPrFilters {
  search: string;
  /** Empty matches every tier. */
  tiers: Array<DifficultyTier>;
  hideDrafts: boolean;
  needsMyAction: boolean;
}

export interface MyPrView {
  filters: MyPrFilters;
  sort: QuestSort;
}

export const DEFAULT_MY_PR_FILTERS: MyPrFilters = {
  search: '',
  tiers: [],
  hideDrafts: false,
  needsMyAction: false,
};

export const DEFAULT_MY_PR_VIEW: MyPrView = { filters: DEFAULT_MY_PR_FILTERS, sort: DEFAULT_SORT };

export function filterMyPullRequests(
  pullRequests: ReadonlyArray<MyPullRequest>,
  filters: MyPrFilters,
): Array<MyPullRequest> {
  return pullRequests.filter(
    (pr) =>
      (filters.tiers.length === 0 || filters.tiers.includes(pr.difficulty)) &&
      !(filters.hideDrafts && pr.isDraft) &&
      !(filters.needsMyAction && !pr.needsMyAction) &&
      matchesSearch(pr, filters.search),
  );
}

const smartRank = (pr: MyPullRequest): number => {
  if (pr.needsMyAction) {
    return 0;
  }
  return pr.reviewState === 'waiting' ? 1 : 2;
};

/**
 * `smart`: needs my action, then waiting on others, then the rest, oldest first within each.
 * `size` and `created` sort the way the review board does, with ties in the smart order.
 */
export function sortMyPullRequests(
  pullRequests: ReadonlyArray<MyPullRequest>,
  sort: QuestSort,
): Array<MyPullRequest> {
  const smart = [...pullRequests].sort(
    (left, right) =>
      smartRank(left) - smartRank(right) || Date.parse(left.openedAt) - Date.parse(right.openedAt),
  );
  if (sort.mode === 'smart') {
    return smart;
  }
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.mode === 'created') {
    return smart.sort(
      (left, right) => sign * (Date.parse(left.openedAt) - Date.parse(right.openedAt)),
    );
  }
  return smart.sort(
    (left, right) =>
      sign * (questSize(left) - questSize(right)) ||
      sign * (left.diffStats.fileCount - right.diffStats.fileCount),
  );
}

export function countNeedingMyAction(pullRequests: ReadonlyArray<MyPullRequest>): number {
  return pullRequests.filter((pr) => pr.needsMyAction).length;
}

export function isFiltered(filters: MyPrFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.tiers.length > 0 ||
    filters.hideDrafts ||
    filters.needsMyAction
  );
}

const tierSchema = z.enum(['Trivial', 'Normal', 'Hard', 'Boss'] satisfies Array<DifficultyTier>);

/** Each field falls back to its default on its own, so one bad value doesn't reset the rest. */
const MyPrViewSchema = z.object({
  filters: z
    .object({
      search: z.string().max(MAX_SEARCH_LENGTH).catch(DEFAULT_MY_PR_FILTERS.search),
      tiers: z.array(tierSchema).catch([]),
      hideDrafts: z.boolean().catch(DEFAULT_MY_PR_FILTERS.hideDrafts),
      needsMyAction: z.boolean().catch(DEFAULT_MY_PR_FILTERS.needsMyAction),
    })
    .catch({ ...DEFAULT_MY_PR_FILTERS }),
  sort: z
    .object({
      mode: z.enum(['smart', 'size', 'created']).catch(DEFAULT_SORT.mode),
      direction: z.enum(['asc', 'desc']).catch(DEFAULT_SORT.direction),
    })
    .catch({ ...DEFAULT_SORT }),
});

export function loadMyPrView(storage: StorageLike | undefined): MyPrView {
  let value: unknown;
  try {
    const text = storage?.getItem(MY_PRS_VIEW_STORAGE_KEY);
    value = text ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  const parsed = MyPrViewSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_MY_PR_VIEW;
}

export function saveMyPrView(storage: StorageLike | undefined, view: MyPrView): void {
  try {
    storage?.setItem(MY_PRS_VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage full or blocked: the tab still works, it just won't remember.
  }
}
