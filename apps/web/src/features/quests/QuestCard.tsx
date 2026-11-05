import { useId } from 'react';

import type { Quest, ReviewProvider, ReviewRun } from '@pr-quest/contract/api';
import { cursorReviewBlocker } from '@pr-quest/contract/cursorReview';
import { formatAge, formatNumber } from '../../platform/format.ts';
import { PullRequestLinks } from '../../platform/PullRequestLinks.tsx';
import { questLabel, type QuestAction, type QuestActionError } from '../game/index.ts';
import { offersRetry, RunStatus } from './RunStatus.tsx';
import type { SettingsTarget } from '../settings/index.ts';
import { TierBadge } from './TierBadge.tsx';

export interface QuestCardProps {
  quest: Quest;
  now: number;
  run?: ReviewRun;
  /** With `cursor`, quests the Cursor agent refuses get a disabled send button and the reason. */
  reviewProvider?: ReviewProvider;
  pendingAction?: QuestAction;
  actionError?: QuestActionError;
  onClickSendAgent: (questId: string) => void;
  onClickOpenResult: (runId: string) => void;
  onClickApprove: (questId: string) => void;
  /** Offered when the action failed for want of a setting, e.g. a missing API key. */
  onClickOpenSettings?: (target: SettingsTarget) => void;
}

/** `owner/repo#123` that wraps after the slash instead of inside the PR number. */
const WrappableLabel = ({ quest }: { quest: Quest }) => (
  <>
    {quest.repo.owner}/<wbr />
    {quest.repo.name}#{quest.number}
  </>
);

export const QuestCard = ({
  quest,
  now,
  run = undefined,
  reviewProvider = undefined,
  pendingAction = undefined,
  actionError = undefined,
  onClickSendAgent,
  onClickOpenResult,
  onClickApprove,
  onClickOpenSettings = undefined,
}: QuestCardProps) => {
  const titleId = useId();
  const draftNoteId = useId();
  const blockedNoteId = useId();
  const isBoss = quest.difficulty === 'Boss';
  const isStarting = pendingAction === 'review';
  const canSendAgent = !run || run.disposition === 'posted';
  const cursorBlocker = reviewProvider === 'cursor' ? cursorReviewBlocker(quest) : undefined;
  const showsBlocker = cursorBlocker !== undefined && (canSendAgent || offersRetry(run));
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
                <WrappableLabel quest={quest} />
              </a>
            ) : (
              <WrappableLabel quest={quest} />
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
        <RunStatus
          onClickOpenResult={onClickOpenResult}
          onClickRetry={sendAgent}
          retryBlockedNoteId={showsBlocker ? blockedNoteId : undefined}
          run={run}
        />
      ) : null}

      {actionError ? (
        <div className="form-error quest__error" role="alert">
          <p>Could not send the agent: {actionError.message}</p>
          {actionError.settings && onClickOpenSettings ? (
            <button
              className="button button--small"
              onClick={() => {
                if (actionError.settings) {
                  onClickOpenSettings(actionError.settings);
                }
              }}
              type="button"
            >
              <span aria-hidden="true">⚙️</span> Open settings
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="quest__actions">
        {canSendAgent ? (
          <button
            aria-describedby={cursorBlocker ? blockedNoteId : undefined}
            className="button button--primary"
            disabled={isStarting || cursorBlocker !== undefined}
            onClick={() => onClickSendAgent(quest.id)}
            type="button"
          >
            {isStarting ? 'Summoning agent…' : 'Summon agent'}
          </button>
        ) : null}
        <PullRequestLinks githubUrl={quest.githubUrl} linearUrl={quest.linearUrl} />
        <button
          aria-describedby={quest.isDraft ? draftNoteId : undefined}
          className="button button--success"
          disabled={quest.isDraft}
          onClick={() => onClickApprove(quest.id)}
          type="button"
        >
          Approve<span className="visually-hidden"> {label}</span>
        </button>
      </div>
      {showsBlocker ? (
        <div className="quest__blocked">
          <p className="muted" id={blockedNoteId}>
            {cursorBlocker}
          </p>
          {onClickOpenSettings ? (
            <button
              className="button button--small"
              onClick={() => onClickOpenSettings({ section: 'provider' })}
              type="button"
            >
              <span aria-hidden="true">⚙️</span> Choose the review provider
            </button>
          ) : null}
        </div>
      ) : null}
      {quest.isDraft ? (
        <p className="muted" id={draftNoteId}>
          Drafts can't be approved yet.
        </p>
      ) : null}
    </article>
  );
};
