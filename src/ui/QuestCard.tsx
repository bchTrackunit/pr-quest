import { useId } from 'react';

import type { Quest, ReviewRun } from '../shared/api.ts';
import { formatAge, formatNumber } from './format.ts';
import { questLabel, type QuestAction } from './gameState.ts';
import { RunStatus } from './RunStatus.tsx';
import { TierBadge } from './TierBadge.tsx';

export interface QuestCardProps {
  quest: Quest;
  now: number;
  run?: ReviewRun;
  pendingAction?: QuestAction;
  actionError?: string;
  onClickSendAgent: (questId: string) => void;
  onClickOpenResult: (runId: string) => void;
  onClickApprove: (questId: string) => void;
}

export const QuestCard = ({
  quest,
  now,
  run = undefined,
  pendingAction = undefined,
  actionError = undefined,
  onClickSendAgent,
  onClickOpenResult,
  onClickApprove,
}: QuestCardProps) => {
  const titleId = useId();
  const isBoss = quest.difficulty === 'Boss';
  const isStarting = pendingAction === 'review';
  const canSendAgent = !run || run.disposition === 'posted';
  const label = questLabel(quest);
  const age = formatAge(quest.requestedAt, now);
  const sendAgent = (): void => onClickSendAgent(quest.id);

  return (
    <article
      aria-labelledby={titleId}
      className={[
        'quest',
        isBoss ? 'quest--boss' : '',
        quest.needsAttention ? 'quest--attention' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {isBoss ? (
        <p aria-hidden="true" className="quest__boss-banner pixel">
          ☠ Boss fight ☠
        </p>
      ) : null}
      <header className="quest__header">
        <TierBadge tier={quest.difficulty} />
        {quest.needsAttention ? (
          <span className="badge badge--attention">
            <span aria-hidden="true">❗</span> Needs attention
          </span>
        ) : null}
        <span className="badge badge--kind">
          {quest.requestKind === 'direct'
            ? 'Direct'
            : `Team: ${quest.requestedTeams.join(', ') || 'team'}`}
        </span>
      </header>

      <h3 className="quest__title" id={titleId}>
        {quest.title}
      </h3>

      <dl className="quest__meta">
        <div>
          <dt>PR</dt>
          <dd>
            {quest.linearUrl ? (
              <a href={quest.githubUrl} rel="noopener noreferrer" target="_blank">
                {label}
              </a>
            ) : (
              label
            )}
          </dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{quest.author.name}</dd>
        </div>
        <div>
          <dt>Waiting</dt>
          <dd>
            <time dateTime={quest.requestedAt}>{age}</time>
          </dd>
        </div>
        <div>
          <dt>Diff</dt>
          <dd>
            <span className="diff-add">+{formatNumber(quest.diffStats.additions)}</span>{' '}
            <span className="diff-del">−{formatNumber(quest.diffStats.deletions)}</span>{' '}
            <span className="muted">
              · {formatNumber(quest.diffStats.fileCount)}{' '}
              {quest.diffStats.fileCount === 1 ? 'file' : 'files'}
            </span>
          </dd>
        </div>
      </dl>

      {run ? (
        <RunStatus onClickOpenResult={onClickOpenResult} onClickRetry={sendAgent} run={run} />
      ) : null}

      {actionError ? (
        <p className="form-error" role="alert">
          Could not send the agent: {actionError}
        </p>
      ) : null}

      <div className="button-row">
        {canSendAgent ? (
          <button
            className="button button--primary"
            disabled={isStarting}
            onClick={() => onClickSendAgent(quest.id)}
            type="button"
          >
            {isStarting ? 'Summoning agent…' : 'Send review agent'}
          </button>
        ) : null}
        <a
          className="button"
          href={quest.linearUrl ?? quest.githubUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          {quest.linearUrl ? 'Open in Linear' : 'Open on GitHub'}
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
        <button
          className="button button--success"
          onClick={() => onClickApprove(quest.id)}
          type="button"
        >
          Approve<span className="visually-hidden"> {label}</span>
        </button>
      </div>
    </article>
  );
};
