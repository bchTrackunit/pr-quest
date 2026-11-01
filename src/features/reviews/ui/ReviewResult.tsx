import { useState } from 'react';

import type {
  FindingSeverity,
  OmittedFileReason,
  PostReviewEvent,
  Quest,
  ReviewRun,
  ReviewVerdict,
} from '../../../shared/api.ts';
import { describeError } from '../../../platform/ui/apiClient.ts';
import { groupFindings, questLabel } from '../../game/ui/index.ts';
import { Modal } from '../../../platform/ui/Modal.tsx';
import { PROVIDER_LABELS } from '../../settings/ui/index.ts';

export interface ReviewResultProps {
  run: ReviewRun;
  quest?: Quest;
  onClickClose: () => void;
  onPost: (event: PostReviewEvent) => Promise<void>;
  onDiscard: () => Promise<void>;
  onClickApprove: (questId: string) => void;
}

const VERDICT_META: Record<ReviewVerdict, { label: string; className: string }> = {
  approve: { label: 'Looks good', className: 'verdict--approve' },
  comment: { label: 'Comments', className: 'verdict--comment' },
  requestChanges: { label: 'Changes requested', className: 'verdict--changes' },
};

const SEVERITY_META: Record<FindingSeverity, { label: string; icon: string }> = {
  critical: { label: 'Critical', icon: '☠' },
  major: { label: 'Major', icon: '⚔' },
  minor: { label: 'Minor', icon: '🛡' },
  nit: { label: 'Nit', icon: '🪶' },
};

const OMITTED_REASON_LABELS: Record<OmittedFileReason, string> = {
  lockfile: 'lockfile',
  generated: 'generated',
  binary: 'binary',
  tooLarge: 'too large',
};

type Pending = 'post' | 'discard' | undefined;

/** "Reviewed by Claude · claude-opus-5"; runs saved before providers existed may lack both. */
function describeReviewer(run: ReviewRun): string | undefined {
  const provider = Object.hasOwn(PROVIDER_LABELS, run.provider)
    ? PROVIDER_LABELS[run.provider]
    : undefined;
  if (!provider && !run.model) {
    return undefined;
  }
  return [provider ? `Reviewed by ${provider}` : 'Reviewed', run.model].filter(Boolean).join(' · ');
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Findings without a line can only go in the review body, so they are not inline comments. */
function describePost(findingCount: number, inlineCount: number): string {
  const prefix = 'This submits one GitHub review with';
  if (findingCount === 0) {
    return `${prefix} the summary and no findings.`;
  }
  const findings = plural(findingCount, 'finding');
  const bodyCount = findingCount - inlineCount;
  if (bodyCount === 0) {
    return `${prefix} ${findings} as inline comments.`;
  }
  if (inlineCount === 0) {
    return `${prefix} ${findings} in the review body.`;
  }
  return `${prefix} ${findings}: ${inlineCount} as inline ${inlineCount === 1 ? 'comment' : 'comments'} and ${bodyCount} in the review body.`;
}

/** The loot screen for a finished run: the agent's summary, verdict and findings, and what to do with them. */
export const ReviewResult = ({
  run,
  quest = undefined,
  onClickClose,
  onPost,
  onDiscard,
  onClickApprove,
}: ReviewResultProps) => {
  const { result } = run;
  const [isConfirmingPost, setIsConfirmingPost] = useState(false);
  /** Never seeded from the verdict: model output must not pick a non-COMMENT event. */
  const [postEvent, setPostEvent] = useState<PostReviewEvent>('comment');
  const [pending, setPending] = useState<Pending>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const summary = quest ?? run.quest;
  const label = questLabel(summary);
  const groups = result ? groupFindings(result.findings) : [];
  const findingCount = result?.findings.length ?? 0;
  const inlineCount = result?.findings.filter((finding) => finding.line !== undefined).length ?? 0;
  const isAwaitingDecision = run.disposition === 'pending';

  const runAction = (action: Pending, request: () => Promise<void>): void => {
    setPending(action);
    setError(undefined);
    request().catch((reason: unknown) => {
      setError(describeError(reason));
      setPending(undefined);
    });
  };

  const verdict = result ? VERDICT_META[result.verdict] : undefined;
  const reviewer = describeReviewer(run);
  const omitted = result?.omitted ?? [];

  return (
    <Modal
      className="modal--wide"
      isBusy={pending !== undefined}
      onClickClose={onClickClose}
      title={`Loot from ${label}`}
    >
      <p className="result__quest">{summary.title}</p>
      {reviewer ? <p className="muted result__reviewer">{reviewer}</p> : null}
      {result && verdict ? (
        <>
          <section aria-labelledby="result-summary" className="result__summary">
            <div className="result__summary-head">
              <h3 className="pixel" id="result-summary">
                Summary
              </h3>
              <span className={['verdict', verdict.className].join(' ')}>
                Agent verdict: {verdict.label}
              </span>
            </div>
            <p className="prewrap">{result.summary}</p>
            <p className="muted">
              The verdict is advice only. PR Quest never turns it into an approval; only you can
              approve.
            </p>
          </section>

          <section aria-labelledby="result-findings">
            <h3 className="pixel" id="result-findings">
              Findings <span className="count">{findingCount}</span>
            </h3>
            {groups.length === 0 ? (
              <p className="board-state board-state--victory">No findings. A flawless victory.</p>
            ) : (
              groups.map((group) => (
                <section
                  aria-labelledby={`severity-${group.severity}`}
                  className={['severity-group', `severity-group--${group.severity}`].join(' ')}
                  key={group.severity}
                >
                  <h4 className="severity-group__title" id={`severity-${group.severity}`}>
                    <span aria-hidden="true">{SEVERITY_META[group.severity].icon}</span>{' '}
                    {SEVERITY_META[group.severity].label}{' '}
                    <span className="count">{group.findings.length}</span>
                  </h4>
                  <ul className="findings">
                    {group.findings.map((finding, index) => (
                      <li
                        className="finding"
                        key={`${finding.file}:${finding.line ?? ''}:${index}`}
                      >
                        <code className="finding__location">
                          {finding.line === undefined
                            ? finding.file
                            : `${finding.file}:${finding.line}`}
                        </code>
                        <p className="prewrap">{finding.body}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              ))
            )}
          </section>

          {omitted.length > 0 ? (
            <section aria-labelledby="result-omitted" className="result__omitted">
              <h3 className="pixel" id="result-omitted">
                Omitted files <span className="count">{omitted.length}</span>
              </h3>
              <p className="muted">
                The reviewer never saw these files, so they have no findings. Check them yourself.
              </p>
              <ul className="omitted-files">
                {omitted.map((entry) => (
                  <li key={entry.file}>
                    <code>{entry.file}</code>{' '}
                    <span className="muted">
                      (
                      {Object.hasOwn(OMITTED_REASON_LABELS, entry.reason)
                        ? OMITTED_REASON_LABELS[entry.reason]
                        : entry.reason}
                      )
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : (
        <p className="form-error" role="alert">
          This run has no readable report.
        </p>
      )}

      {run.disposition === 'posted' ? (
        <p className="muted">
          Already posted.{' '}
          {run.postedReviewUrl ? (
            <a href={run.postedReviewUrl} rel="noopener noreferrer" target="_blank">
              View the review on GitHub
            </a>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {isConfirmingPost ? (
        <fieldset className="confirm-post" disabled={pending !== undefined}>
          <legend className="pixel">Post to {label}?</legend>
          <p>
            {describePost(findingCount, inlineCount)} If GitHub rejects a line, every finding goes
            in the body instead. It also shows up in Linear.
          </p>
          <label className="radio">
            <input
              checked={postEvent === 'comment'}
              name="post-event"
              onChange={() => setPostEvent('comment')}
              type="radio"
              value="comment"
            />{' '}
            Comment
          </label>
          <label className="radio">
            <input
              checked={postEvent === 'requestChanges'}
              name="post-event"
              onChange={() => setPostEvent('requestChanges')}
              type="radio"
              value="requestChanges"
            />{' '}
            Request changes
          </label>
          {result?.verdict === 'requestChanges' ? (
            <p className="muted">
              The agent suggests requesting changes; that is advice. Pick the event yourself.
            </p>
          ) : null}
          <div className="button-row button-row--end">
            <button
              className="button"
              data-autofocus
              onClick={() => setIsConfirmingPost(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="button button--primary"
              onClick={() => runAction('post', () => onPost(postEvent))}
              type="button"
            >
              {pending === 'post' ? 'Posting…' : 'Confirm post'}
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="button-row result__actions">
          {result && isAwaitingDecision ? (
            <button
              className="button button--primary"
              disabled={pending !== undefined}
              onClick={() => setIsConfirmingPost(true)}
              type="button"
            >
              Post to PR
            </button>
          ) : null}
          {isAwaitingDecision ? (
            <button
              className="button button--danger"
              disabled={pending !== undefined}
              onClick={() => runAction('discard', onDiscard)}
              type="button"
            >
              {pending === 'discard' ? 'Discarding…' : 'Discard'}
            </button>
          ) : null}
          <a
            className="button"
            href={summary.linearUrl ?? summary.githubUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            {summary.linearUrl ? 'Open in Linear' : 'Open on GitHub'}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
          {quest ? (
            <button
              className="button button--success"
              disabled={pending !== undefined}
              onClick={() => onClickApprove(quest.id)}
              type="button"
            >
              Approve
            </button>
          ) : null}
        </div>
      )}
    </Modal>
  );
};
