import { useId } from 'react';

import type {
  CiState,
  MergeState,
  MyPullRequest,
  MyPullRequestReviewState,
  ReviewProvider,
  ReviewRun,
} from '@pr-quest/contract/api';
import { cursorReviewBlocker } from '@pr-quest/contract/cursorReview';
import { formatAge, formatNumber } from '../../platform/format.ts';
import { PullRequestLinks } from '../../platform/PullRequestLinks.tsx';
import type { QuestAction, QuestActionError } from '../game/index.ts';
import { offersRetry, RunStatus } from './RunStatus.tsx';
import type { SettingsTarget } from '../settings/index.ts';
import { TierBadge } from './TierBadge.tsx';

export interface MyPullRequestCardProps {
  pullRequest: MyPullRequest;
  now: number;
  run?: ReviewRun;
  reviewProvider?: ReviewProvider;
  pendingAction?: QuestAction;
  actionError?: QuestActionError;
  onClickSelfReview: (prId: string) => void;
  onClickOpenResult: (runId: string) => void;
  onClickOpenSettings?: (target: SettingsTarget) => void;
}

interface BadgeMeta {
  label: string;
  icon: string;
  className: string;
}

const REVIEW_BADGES: Record<MyPullRequestReviewState, BadgeMeta> = {
  approved: { label: 'Approved', icon: '✅', className: 'badge--good' },
  changesRequested: { label: 'Changes requested', icon: '✋', className: 'badge--attention' },
  waiting: { label: 'Waiting on review', icon: '⏳', className: 'badge--kind' },
};

const CI_BADGES: Record<CiState, BadgeMeta> = {
  passing: { label: 'CI passing', icon: '✔', className: 'badge--good' },
  failing: { label: 'CI failing', icon: '✖', className: 'badge--bad' },
  running: { label: 'CI running', icon: '⟳', className: 'badge--busy' },
  none: { label: 'No checks', icon: '–', className: 'badge--kind' },
  unknown: { label: 'CI unknown', icon: '?', className: 'badge--kind' },
};

/** A clean branch needs no badge; GitHub only reports `behind` when the repo requires updating. */
const MERGE_BADGES: Record<Exclude<MergeState, 'clean'>, BadgeMeta> = {
  conflicting: { label: 'Merge conflicts', icon: '⚔', className: 'badge--bad' },
  behind: { label: 'Out of date', icon: '↧', className: 'badge--attention' },
  unknown: { label: 'Merge state unknown', icon: '?', className: 'badge--kind' },
};

const Badge = ({ meta }: { meta: BadgeMeta }) => (
  <span className={['badge', meta.className].join(' ')}>
    <span aria-hidden="true">{meta.icon}</span> {meta.label}
  </span>
);

function threadsLabel(pr: MyPullRequest): string {
  const count = `${pr.unresolvedThreads}${pr.moreThreads ? '+' : ''}`;
  return `${count} unresolved ${pr.unresolvedThreads === 1 && !pr.moreThreads ? 'thread' : 'threads'}`;
}

/** One of the player's open PRs: what it needs, from them or from others, and a self-review. */
export const MyPullRequestCard = ({
  pullRequest: pr,
  now,
  run = undefined,
  reviewProvider = undefined,
  pendingAction = undefined,
  actionError = undefined,
  onClickSelfReview,
  onClickOpenResult,
  onClickOpenSettings = undefined,
}: MyPullRequestCardProps) => {
  const titleId = useId();
  const blockedNoteId = useId();
  const isStarting = pendingAction === 'review';
  const canSendAgent = !run;
  const cursorBlocker = reviewProvider === 'cursor' ? cursorReviewBlocker(pr) : undefined;
  const showsBlocker = cursorBlocker !== undefined && (canSendAgent || offersRetry(run));
  const selfReview = (): void => onClickSelfReview(pr.id);
  const showsThreads = pr.unresolvedThreads > 0 || pr.moreThreads === true;

  return (
    <article
      aria-labelledby={titleId}
      className={['quest', pr.needsMyAction ? 'quest--attention' : ''].filter(Boolean).join(' ')}
    >
      <header className="quest__header">
        <TierBadge tier={pr.difficulty} />
        {pr.needsMyAction ? (
          <span className="badge badge--attention">
            <span aria-hidden="true">❗</span> Needs my action
          </span>
        ) : null}
        {pr.isDraft ? <span className="badge badge--kind">Draft</span> : null}
      </header>

      <h3 className="quest__title" id={titleId}>
        {pr.title}
      </h3>

      <ul aria-label="Status" className="quest__header quest__status">
        <li>
          <Badge meta={REVIEW_BADGES[pr.reviewState]} />
        </li>
        <li>
          <Badge meta={CI_BADGES[pr.ciState]} />
        </li>
        {pr.mergeState === 'clean' ? null : (
          <li>
            <Badge meta={MERGE_BADGES[pr.mergeState]} />
          </li>
        )}
        {showsThreads ? (
          <li>
            <span className="badge badge--attention">
              <span aria-hidden="true">💬</span> {threadsLabel(pr)}
            </span>
          </li>
        ) : null}
      </ul>

      <dl className="quest__meta">
        <div>
          <dt>PR</dt>
          <dd>
            {pr.repo.owner}/<wbr />
            {pr.repo.name}#{pr.number}
          </dd>
        </div>
        <div>
          <dt>Open for</dt>
          <dd>
            <time dateTime={pr.openedAt}>{formatAge(pr.openedAt, now)}</time>
          </dd>
        </div>
        <div>
          <dt>Diff</dt>
          <dd>
            <span className="diff-add">+{formatNumber(pr.diffStats.additions)}</span>{' '}
            <span className="diff-del">−{formatNumber(pr.diffStats.deletions)}</span>{' '}
            <span className="muted">
              · {formatNumber(pr.diffStats.fileCount)}{' '}
              {pr.diffStats.fileCount === 1 ? 'file' : 'files'}
            </span>
          </dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>
            <code>{pr.sourceBranch}</code>
          </dd>
        </div>
      </dl>

      {run ? (
        <RunStatus
          onClickOpenResult={onClickOpenResult}
          onClickRetry={selfReview}
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
            onClick={selfReview}
            type="button"
          >
            {isStarting ? 'Summoning agent…' : 'Summon agent'}
          </button>
        ) : null}
        <PullRequestLinks githubUrl={pr.githubUrl} />
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
    </article>
  );
};
