import type { MouseEventHandler } from 'react';

import type { ReviewRun } from '../../../shared/api.ts';
import { ElapsedClock } from './ElapsedClock.tsx';

export interface RunStatusProps {
  run: ReviewRun;
  onClickOpenResult: (runId: string) => void;
  onClickRetry: MouseEventHandler<HTMLButtonElement>;
  /** Disables Retry, pointing at the element that says why. */
  retryBlockedNoteId?: string;
}

/** The run failed or came back unreadable, so the card offers to send the agent again. */
export const offersRetry = (run: ReviewRun): boolean =>
  run.status === 'error' ||
  run.status === 'startupFailed' ||
  (run.status === 'finished' && run.disposition !== 'posted' && !run.result);

/**
 * The quest card's view of a review agent run, from queued through loot or defeat. Failures are
 * static text: the error toast already announces the change, and an alert per failed card would
 * fire for every one of them on page load.
 */
export const RunStatus = ({
  run,
  onClickOpenResult,
  onClickRetry,
  retryBlockedNoteId = undefined,
}: RunStatusProps) => {
  const retry = (
    <button
      aria-describedby={retryBlockedNoteId}
      className="button button--small"
      disabled={retryBlockedNoteId !== undefined}
      onClick={onClickRetry}
      type="button"
    >
      Retry
    </button>
  );
  switch (run.status) {
    case 'queued':
      return (
        <div className="run run--queued" role="status">
          <span aria-hidden="true" className="run__icon">
            ⏳
          </span>
          <span>Agent is gearing up…</span>
        </div>
      );
    case 'running':
      return (
        <div className="run run--running">
          <span aria-hidden="true" className="run__icon run__icon--walk">
            🧙
          </span>
          <span role="status">Agent on quest</span>
          <span aria-hidden="true" className="run__dots">
            <span />
            <span />
            <span />
          </span>
          <ElapsedClock startedAt={run.startedAt} />
        </div>
      );
    case 'finished':
      if (run.disposition === 'posted') {
        return (
          <div className="run run--posted">
            <span aria-hidden="true">📜</span>
            <span>Review posted.</span>
            {run.postedReviewUrl ? (
              <a href={run.postedReviewUrl} rel="noopener noreferrer" target="_blank">
                View on GitHub
              </a>
            ) : null}
          </div>
        );
      }
      if (!run.result) {
        return (
          <div className="run run--error">
            <span>The agent came back without a readable report.</span>
            {retry}
          </div>
        );
      }
      return (
        <button
          className="button button--loot"
          onClick={() => onClickOpenResult(run.id)}
          type="button"
        >
          <span aria-hidden="true">✨</span> Loot ready: {run.result.findings.length}{' '}
          {run.result.findings.length === 1 ? 'finding' : 'findings'}
        </button>
      );
    case 'error':
    case 'startupFailed':
      return (
        <div className="run run--error">
          <span aria-hidden="true">💀</span>
          <span>
            {run.status === 'startupFailed'
              ? 'The agent never set out'
              : 'The agent fell in battle'}
            : {run.error?.message ?? 'unknown error'}
          </span>
          {retry}
        </div>
      );
    default:
      return null;
  }
};
