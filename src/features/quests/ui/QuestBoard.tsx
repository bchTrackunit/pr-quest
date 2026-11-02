import { useEffect, useMemo, useRef, type MouseEventHandler } from 'react';

import type {
  Quest,
  QuestSource,
  RateLimitStatus,
  RequestKind,
  ReviewProvider,
  ReviewRun,
} from '../../../shared/api.ts';
import { formatAgo, formatClock, formatElapsed } from '../../../platform/ui/format.ts';
import {
  activeRateLimit,
  selectRunForQuest,
  type LoadState,
  type QuestAction,
  type QuestActionError,
} from '../../game/ui/index.ts';
import { QuestCard } from './QuestCard.tsx';
import { moveFocusWithArrows, QuestFilterBar } from './QuestFilterBar.tsx';
import {
  countByKind,
  DEFAULT_FILTERS,
  filterQuests,
  KIND_LABELS,
  sortBoardQuests,
  type KindFilter,
  type RunLookup,
} from './questFilters.ts';
import type { SettingsTarget } from '../../settings/ui/index.ts';
import { useBoardView } from './useBoardView.ts';
import { useNow } from '../../../platform/ui/useNow.ts';

export interface QuestBoardProps {
  quests: Array<Quest>;
  runs: Record<string, ReviewRun>;
  loadState: LoadState;
  error?: string;
  fetchedAt?: string;
  source?: QuestSource;
  stale?: boolean;
  rateLimit?: RateLimitStatus;
  reviewProvider?: ReviewProvider;
  questActions: Record<string, QuestAction>;
  questActionErrors: Record<string, QuestActionError>;
  onClickRefresh: MouseEventHandler<HTMLButtonElement>;
  onClickSendAgent: (questId: string) => void;
  onClickOpenResult: (runId: string) => void;
  onClickApprove: (questId: string) => void;
  onClickOpenSettings?: (target: SettingsTarget) => void;
}

const KIND_FILTERS: ReadonlyArray<KindFilter> = ['all', 'direct', 'team'];

const GROUPS: ReadonlyArray<{ kind: RequestKind; title: string; subtitle: string }> = [
  { kind: 'direct', title: 'Direct requests', subtitle: 'You were summoned by name.' },
  { kind: 'team', title: 'Team requests', subtitle: 'Your guild was called upon.' },
];

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export const QuestBoard = ({
  quests,
  runs,
  loadState,
  error = undefined,
  fetchedAt = undefined,
  source = undefined,
  stale = false,
  rateLimit = undefined,
  reviewProvider = undefined,
  questActions,
  questActionErrors,
  onClickRefresh,
  onClickSendAgent,
  onClickOpenResult,
  onClickApprove,
  onClickOpenSettings = undefined,
}: QuestBoardProps) => {
  const board = useBoardView();
  const { filters, sort } = board.view;
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow(rateLimit ? 1000 : 30_000);
  const limit = activeRateLimit(rateLimit, now);
  const isLoading = loadState === 'loading';
  const isFirstLoad = isLoading && !fetchedAt && quests.length === 0;

  const runFor = useMemo<RunLookup>(() => (quest) => selectRunForQuest(runs, quest), [runs]);
  const visible = useMemo(
    () => sortBoardQuests(filterQuests(quests, filters, runFor), sort),
    [quests, filters, sort, runFor],
  );
  const counts = useMemo(() => countByKind(quests, filters, runFor), [quests, filters, runFor]);
  const clearFilters = (): void =>
    board.setView((current) => ({ ...current, filters: DEFAULT_FILTERS }));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key === '/' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const renderCards = (list: Array<Quest>) => (
    <ul className="quest-list">
      {list.map((quest) => (
        <li key={quest.id}>
          <QuestCard
            actionError={questActionErrors[quest.id]}
            now={now}
            onClickApprove={onClickApprove}
            onClickOpenResult={onClickOpenResult}
            onClickOpenSettings={onClickOpenSettings}
            onClickSendAgent={onClickSendAgent}
            pendingAction={questActions[quest.id]}
            quest={quest}
            reviewProvider={reviewProvider}
            run={runFor(quest)}
          />
        </li>
      ))}
    </ul>
  );

  const renderBody = () => {
    if (isFirstLoad) {
      return (
        <div aria-busy="true" className="board-state" role="status">
          <span aria-hidden="true" className="board-state__icon board-state__icon--spin">
            🗺️
          </span>
          <p>Unrolling the quest map…</p>
        </div>
      );
    }
    if (loadState === 'error' && quests.length === 0) {
      return (
        <div className="board-state board-state--error" role="alert">
          <span aria-hidden="true" className="board-state__icon">
            🐉
          </span>
          <p className="pixel">The quest board could not be read</p>
          <p>{error ?? 'Unknown error'}</p>
          <button className="button button--primary" onClick={onClickRefresh} type="button">
            Try again
          </button>
        </div>
      );
    }
    if (quests.length === 0) {
      return (
        <div className="board-state board-state--victory">
          <span aria-hidden="true" className="board-state__icon board-state__icon--bounce">
            🏆
          </span>
          <p className="pixel">Inbox Zero!</p>
          <p>Every quest is complete. The realm is at peace, for now.</p>
        </div>
      );
    }
    if (visible.length === 0) {
      return (
        <div className="board-state board-state--filtered">
          <span aria-hidden="true" className="board-state__icon">
            🔍
          </span>
          <p className="pixel">No quests match</p>
          <p>
            Your filters hide all {quests.length} {quests.length === 1 ? 'quest' : 'quests'}. The
            realm still needs you.
          </p>
          <button className="button button--primary" onClick={clearFilters} type="button">
            Clear filters
          </button>
        </div>
      );
    }
    if (filters.kind === 'all') {
      return GROUPS.map((group) => {
        const list = visible.filter((quest) => quest.requestKind === group.kind);
        return list.length > 0 ? (
          <section aria-labelledby={`group-${group.kind}`} className="quest-group" key={group.kind}>
            <h3 className="quest-group__title pixel" id={`group-${group.kind}`}>
              {group.title} <span className="count">{list.length}</span>
            </h3>
            <p className="muted">{group.subtitle}</p>
            {renderCards(list)}
          </section>
        ) : null;
      });
    }
    return renderCards(visible);
  };

  const retryInMs = limit ? Date.parse(limit.limitedUntil) - now : 0;

  return (
    <section aria-labelledby="quest-board-title" className="board">
      <header className="board__header">
        <div>
          <h2 className="board__title pixel" id="quest-board-title">
            Quest Board
          </h2>
          <p className="muted board__subtitle">
            {fetchedAt ? `Updated ${formatAgo(fetchedAt, now)}` : 'Not loaded yet'}
            {source ? ` · via ${source === 'linear' ? 'Linear' : 'GitHub'}` : ''}
            {stale && !limit ? ' · cached' : ''}
          </p>
        </div>
        <div className="board__controls">
          <div
            aria-label="Filter quests"
            className="segmented"
            onKeyDown={moveFocusWithArrows}
            role="group"
          >
            {KIND_FILTERS.map((kind) => (
              <button
                aria-pressed={filters.kind === kind}
                className="segmented__option"
                key={kind}
                onClick={() =>
                  board.setView((current) => ({
                    ...current,
                    filters: { ...current.filters, kind },
                  }))
                }
                type="button"
              >
                {KIND_LABELS[kind]} <span className="count">{counts[kind]}</span>
              </button>
            ))}
          </div>
          <button
            aria-busy={isLoading}
            aria-describedby={limit ? 'rate-limit-banner' : undefined}
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
        <p className="notice notice--calm" id="rate-limit-banner" role="status">
          <span aria-hidden="true">🛡️</span>{' '}
          {limit.kind === 'secondary'
            ? 'GitHub asked PR Quest to slow down'
            : 'GitHub rate limit reached'}
          , showing results from {formatClock(fetchedAt)}, retrying at{' '}
          {formatClock(limit.limitedUntil)}.
        </p>
      ) : null}
      {loadState === 'error' && quests.length > 0 ? (
        <p className="form-error" role="alert">
          Refresh failed: {error ?? 'Unknown error'}. Showing the last known quests.
        </p>
      ) : null}
      {isFirstLoad || quests.length === 0 ? null : (
        <QuestFilterBar
          onChangeView={board.setView}
          onClickApplyPreset={board.applyPreset}
          onClickDeletePreset={board.deletePreset}
          onSavePreset={board.savePreset}
          presets={board.presets}
          searchRef={searchRef}
          shownCount={visible.length}
          totalCount={quests.length}
          view={board.view}
        />
      )}
      {renderBody()}
    </section>
  );
};
