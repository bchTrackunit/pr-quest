import { useMemo, useState, type MouseEventHandler } from 'react';

import type { Quest, QuestSource, RequestKind, ReviewRun } from '../shared/api.ts';
import { formatAge } from './format.ts';
import { selectRunForQuest, sortQuests, type LoadState, type QuestAction } from './gameState.ts';
import { QuestCard } from './QuestCard.tsx';
import { useNow } from './useNow.ts';

export interface QuestBoardProps {
  quests: Array<Quest>;
  runs: Record<string, ReviewRun>;
  loadState: LoadState;
  error?: string;
  fetchedAt?: string;
  source?: QuestSource;
  questActions: Record<string, QuestAction>;
  questActionErrors: Record<string, string>;
  onClickRefresh: MouseEventHandler<HTMLButtonElement>;
  onClickSendAgent: (questId: string) => void;
  onClickOpenResult: (runId: string) => void;
  onClickApprove: (questId: string) => void;
}

type QuestFilter = 'all' | RequestKind;

const FILTERS: ReadonlyArray<{ value: QuestFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'direct', label: 'Direct' },
  { value: 'team', label: 'Team' },
];

const GROUPS: ReadonlyArray<{ kind: RequestKind; title: string; subtitle: string }> = [
  { kind: 'direct', title: 'Direct requests', subtitle: 'You were summoned by name.' },
  { kind: 'team', title: 'Team requests', subtitle: 'Your guild was called upon.' },
];

export const QuestBoard = ({
  quests,
  runs,
  loadState,
  error = undefined,
  fetchedAt = undefined,
  source = undefined,
  questActions,
  questActionErrors,
  onClickRefresh,
  onClickSendAgent,
  onClickOpenResult,
  onClickApprove,
}: QuestBoardProps) => {
  const [filter, setFilter] = useState<QuestFilter>('all');
  const now = useNow(30_000);
  const sorted = useMemo(() => sortQuests(quests), [quests]);
  const isLoading = loadState === 'loading';
  const isFirstLoad = isLoading && !fetchedAt && quests.length === 0;
  const counts: Record<QuestFilter, number> = {
    all: quests.length,
    direct: quests.filter((quest) => quest.requestKind === 'direct').length,
    team: quests.filter((quest) => quest.requestKind === 'team').length,
  };

  const renderCards = (list: Array<Quest>) => (
    <ul className="quest-list">
      {list.map((quest) => (
        <li key={quest.id}>
          <QuestCard
            actionError={questActionErrors[quest.id]}
            now={now}
            onClickApprove={onClickApprove}
            onClickOpenResult={onClickOpenResult}
            onClickSendAgent={onClickSendAgent}
            pendingAction={questActions[quest.id]}
            quest={quest}
            run={selectRunForQuest(runs, quest)}
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
    if (filter === 'all') {
      return GROUPS.map((group) => {
        const list = sorted.filter((quest) => quest.requestKind === group.kind);
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
    const filtered = sorted.filter((quest) => quest.requestKind === filter);
    return filtered.length > 0 ? (
      renderCards(filtered)
    ) : (
      <div className="board-state">
        <p>No {filter} quests right now.</p>
      </div>
    );
  };

  return (
    <section aria-labelledby="quest-board-title" className="board">
      <header className="board__header">
        <div>
          <h2 className="board__title pixel" id="quest-board-title">
            Quest Board
          </h2>
          <p className="muted board__subtitle">
            {fetchedAt ? `Updated ${formatAge(fetchedAt, now)} ago` : 'Not loaded yet'}
            {source ? ` · via ${source === 'linear' ? 'Linear' : 'GitHub'}` : ''}
          </p>
        </div>
        <div className="board__controls">
          <div aria-label="Filter quests" className="segmented" role="group">
            {FILTERS.map((option) => (
              <button
                aria-pressed={filter === option.value}
                className="segmented__option"
                key={option.value}
                onClick={() => setFilter(option.value)}
                type="button"
              >
                {option.label} <span className="count">{counts[option.value]}</span>
              </button>
            ))}
          </div>
          <button
            aria-busy={isLoading}
            className="button"
            disabled={isLoading}
            onClick={onClickRefresh}
            type="button"
          >
            <span aria-hidden="true" className={isLoading ? 'spin' : ''}>
              ↻
            </span>{' '}
            {isLoading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>
      {loadState === 'error' && quests.length > 0 ? (
        <p className="form-error" role="alert">
          Refresh failed: {error ?? 'Unknown error'}. Showing the last known quests.
        </p>
      ) : null}
      {renderBody()}
    </section>
  );
};
