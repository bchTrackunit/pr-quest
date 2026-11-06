import { useId, useMemo, useRef, type MouseEventHandler } from 'react';

import type {
  MyPullRequest,
  RateLimitStatus,
  ReviewProvider,
  ReviewRun,
} from '@pr-quest/contract/api';
import { formatAgo, formatClock, formatElapsed } from '../../platform/format.ts';
import {
  activeRateLimit,
  selectRunForQuest,
  type LoadState,
  type QuestAction,
  type QuestActionError,
} from '../game/index.ts';
import {
  DEFAULT_MY_PR_FILTERS,
  filterMyPullRequests,
  isFiltered,
  sortMyPullRequests,
  type MyPrFilters,
} from './myPrFilters.ts';
import { MyPullRequestCard } from './MyPullRequestCard.tsx';
import { SearchField, ToggleGroup } from './QuestFilterBar.tsx';
import { DIFFICULTY_TIERS, toggleValue, type QuestSort } from './questFilters.ts';
import type { SettingsTarget } from '../settings/index.ts';
import { useMyPrView } from './useMyPrView.ts';
import { useSlashFocus } from './useSlashFocus.ts';
import { useNow } from '../../platform/useNow.ts';

export interface MyPullRequestBoardProps {
  pullRequests: Array<MyPullRequest>;
  runs: Record<string, ReviewRun>;
  loadState: LoadState;
  error?: string;
  fetchedAt?: string;
  stale?: boolean;
  rateLimit?: RateLimitStatus;
  reviewProvider?: ReviewProvider;
  questActions: Record<string, QuestAction>;
  questActionErrors: Record<string, QuestActionError>;
  onClickRefresh: MouseEventHandler<HTMLButtonElement>;
  onClickSelfReview: (prId: string) => void;
  onClickOpenResult: (runId: string) => void;
  onClickOpenSettings?: (target: SettingsTarget) => void;
}

const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string; sort: QuestSort }> = [
  { value: 'smart', label: 'Smart', sort: { mode: 'smart', direction: 'asc' } },
  { value: 'size-asc', label: 'Smallest first', sort: { mode: 'size', direction: 'asc' } },
  { value: 'size-desc', label: 'Largest first', sort: { mode: 'size', direction: 'desc' } },
  { value: 'created-desc', label: 'Newest first', sort: { mode: 'created', direction: 'desc' } },
  { value: 'created-asc', label: 'Oldest first', sort: { mode: 'created', direction: 'asc' } },
];

const sortValue = (sort: QuestSort): string =>
  sort.mode === 'smart' ? 'smart' : `${sort.mode}-${sort.direction}`;

/** The player's own open PRs, with what each needs, and a self-review for each. */
export const MyPullRequestBoard = ({
  pullRequests,
  runs,
  loadState,
  error = undefined,
  fetchedAt = undefined,
  stale = false,
  rateLimit = undefined,
  reviewProvider = undefined,
  questActions,
  questActionErrors,
  onClickRefresh,
  onClickSelfReview,
  onClickOpenResult,
  onClickOpenSettings = undefined,
}: MyPullRequestBoardProps) => {
  const { view, setView } = useMyPrView();
  const { filters, sort } = view;
  const sortId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef);
  const now = useNow(rateLimit ? 1000 : 30_000);
  const limit = activeRateLimit(rateLimit, now);
  const isLoading = loadState === 'loading';
  const isFirstLoad = isLoading && !fetchedAt && pullRequests.length === 0;
  const visible = useMemo(
    () => sortMyPullRequests(filterMyPullRequests(pullRequests, filters), sort),
    [pullRequests, filters, sort],
  );
  const setFilters = (update: Partial<MyPrFilters>): void =>
    setView((current) => ({ ...current, filters: { ...current.filters, ...update } }));
  const commitSearch = (search: string): void =>
    setView((current) => ({ ...current, filters: { ...current.filters, search } }));
  const retryInMs = limit ? Date.parse(limit.limitedUntil) - now : 0;

  const renderBody = () => {
    if (isFirstLoad) {
      return (
        <div aria-busy="true" className="board-state" role="status">
          <span aria-hidden="true" className="board-state__icon board-state__icon--spin">
            🗺️
          </span>
          <p>Gathering your PRs…</p>
        </div>
      );
    }
    if (loadState === 'error' && pullRequests.length === 0) {
      return (
        <div className="board-state board-state--error" role="alert">
          <span aria-hidden="true" className="board-state__icon">
            🐉
          </span>
          <p className="pixel">Your PRs could not be read</p>
          <p>{error ?? 'Unknown error'}</p>
          <button className="button button--primary" onClick={onClickRefresh} type="button">
            Try again
          </button>
        </div>
      );
    }
    if (pullRequests.length === 0) {
      return (
        <div className="board-state board-state--victory">
          <span aria-hidden="true" className="board-state__icon">
            🏕️
          </span>
          <p className="pixel">No open PRs</p>
          <p>Nothing of yours is waiting. Time to start the next adventure.</p>
        </div>
      );
    }
    if (visible.length === 0) {
      return (
        <div className="board-state board-state--filtered">
          <span aria-hidden="true" className="board-state__icon">
            🔍
          </span>
          <p className="pixel">No PRs match</p>
          <p>
            Your filters hide all {pullRequests.length} of your{' '}
            {pullRequests.length === 1 ? 'PR' : 'PRs'}.
          </p>
          <button
            className="button button--primary"
            onClick={() => setFilters(DEFAULT_MY_PR_FILTERS)}
            type="button"
          >
            Clear filters
          </button>
        </div>
      );
    }
    return (
      <ul className="quest-list">
        {visible.map((pr) => (
          <li key={pr.id}>
            <MyPullRequestCard
              actionError={questActionErrors[pr.id]}
              now={now}
              onClickOpenResult={onClickOpenResult}
              onClickOpenSettings={onClickOpenSettings}
              onClickSelfReview={onClickSelfReview}
              pendingAction={questActions[pr.id]}
              pullRequest={pr}
              reviewProvider={reviewProvider}
              run={selectRunForQuest(runs, pr)}
            />
          </li>
        ))}
      </ul>
    );
  };

  return (
    <section aria-labelledby="my-prs-title" className="board">
      <header className="board__header">
        <div>
          <h2 className="board__title pixel" id="my-prs-title">
            My PRs
          </h2>
          <p className="muted board__subtitle">
            {fetchedAt ? `Updated ${formatAgo(fetchedAt, now)}` : 'Not loaded yet'}
            {stale && !limit ? ' · cached' : ''}
          </p>
        </div>
        <div className="board__controls">
          <button
            aria-busy={isLoading}
            aria-describedby={limit ? 'my-prs-rate-limit' : undefined}
            className="button"
            disabled={isLoading || limit !== undefined}
            onClick={onClickRefresh}
            type="button"
          >
            <span aria-hidden="true" className={isLoading ? 'spin' : ''}>
              {limit ? '⏳' : '↻'}
            </span>{' '}
            {limit ? `Retry in ${formatElapsed(retryInMs)}` : isLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>
      {limit && fetchedAt ? (
        <p className="notice notice--calm" id="my-prs-rate-limit" role="status">
          <span aria-hidden="true">🛡️</span>{' '}
          {limit.kind === 'secondary'
            ? 'GitHub asked PR Quest to slow down'
            : 'GitHub rate limit reached'}
          , showing results from {formatClock(fetchedAt)}, retrying at{' '}
          {formatClock(limit.limitedUntil)}.
        </p>
      ) : null}
      {loadState === 'error' && pullRequests.length > 0 ? (
        <p className="form-error" role="alert">
          Refresh failed: {error ?? 'Unknown error'}. Showing the last known PRs.
        </p>
      ) : null}
      {isFirstLoad || pullRequests.length === 0 ? null : (
        <section aria-label="Filter and sort your PRs" className="filters">
          <div className="filters__toolbar">
            <SearchField
              inputRef={searchRef}
              label="Search your PRs"
              onCommit={commitSearch}
              value={filters.search}
            />
            <div className="filters__sort">
              <label className="filters__label" htmlFor={sortId}>
                Sort
              </label>
              <select
                className="field__input filters__select"
                id={sortId}
                onChange={(event) => {
                  const option = SORT_OPTIONS.find((entry) => entry.value === event.target.value);
                  if (option) {
                    setView((current) => ({ ...current, sort: option.sort }));
                  }
                }}
                value={sortValue(sort)}
              >
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div aria-label="Filters" className="filters__panel" role="group">
            <ToggleGroup label="Difficulty">
              {DIFFICULTY_TIERS.map((tier) => (
                <button
                  aria-pressed={filters.tiers.includes(tier)}
                  className="segmented__option"
                  key={tier}
                  onClick={() =>
                    setFilters({ tiers: toggleValue(filters.tiers, tier, DIFFICULTY_TIERS) })
                  }
                  type="button"
                >
                  {tier}
                </button>
              ))}
            </ToggleGroup>
            <ToggleGroup className="filters__switches" label="Show">
              <button
                aria-pressed={filters.needsMyAction}
                className="button button--small switch"
                onClick={() => setFilters({ needsMyAction: !filters.needsMyAction })}
                type="button"
              >
                <span aria-hidden="true" className="switch__box">
                  {filters.needsMyAction ? '■' : '□'}
                </span>
                Only needs my action
              </button>
              <button
                aria-pressed={filters.hideDrafts}
                className="button button--small switch"
                onClick={() => setFilters({ hideDrafts: !filters.hideDrafts })}
                type="button"
              >
                <span aria-hidden="true" className="switch__box">
                  {filters.hideDrafts ? '■' : '□'}
                </span>
                Hide drafts
              </button>
            </ToggleGroup>
          </div>
          <div className="filters__summary">
            <p aria-live="polite" className="filters__count">
              Showing <strong>{visible.length}</strong> of <strong>{pullRequests.length}</strong>{' '}
              {pullRequests.length === 1 ? 'PR' : 'PRs'}
            </p>
            {isFiltered(filters) ? (
              <button
                className="link-button filters__clear"
                onClick={() => setFilters(DEFAULT_MY_PR_FILTERS)}
                type="button"
              >
                Clear all
              </button>
            ) : null}
          </div>
        </section>
      )}
      {renderBody()}
    </section>
  );
};
