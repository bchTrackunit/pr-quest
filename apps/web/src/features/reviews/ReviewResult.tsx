import { useState } from 'react';

import type {
  FindingDecision,
  FindingSeverity,
  OmittedFileReason,
  PostReviewEvent,
  Quest,
  ReviewFinding,
  ReviewRun,
  ReviewVerdict,
} from '@pr-quest/contract/api';
import { describeError } from '../../platform/apiClient.ts';
import { findingDecisionsOf } from '@pr-quest/contract/findingDecisions';
import { FindingDecisionToggle } from './FindingDecisionToggle.tsx';
import { groupFindings, questLabel } from '../game/index.ts';
import { Modal } from '../../platform/Modal.tsx';
import { PROVIDER_LABELS } from '../settings/index.ts';

export interface ReviewResultProps {
  run: ReviewRun;
  quest?: Quest;
  onClickClose: () => void;
  /** Saves the decision on the findings, by index into `result.findings`. */
  onDecide: (findingIndexes: Array<number>, decision: FindingDecision) => Promise<void>;
  /** `findingIndexes` are the accepted findings the confirmation described. */
  onPost: (event: PostReviewEvent, findingIndexes: Array<number>) => Promise<void>;
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

/** Decisions shown while their saves are in flight; the run's own decisions win once all settle. */
interface UnsavedDecisions {
  decisions: ReadonlyMap<number, FindingDecision>;
  saving: number;
}

const NOTHING_UNSAVED: UnsavedDecisions = { decisions: new Map(), saving: 0 };

type DecisionCounts = Record<FindingDecision, number>;

function countDecisions(decisions: ReadonlyArray<FindingDecision>): DecisionCounts {
  const counts: DecisionCounts = { accepted: 0, rejected: 0, undecided: 0 };
  for (const decision of decisions) {
    counts[decision] += 1;
  }
  return counts;
}

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

function describeLeftOut({ rejected, undecided }: DecisionCounts): string | undefined {
  const parts = [
    rejected > 0 ? `${rejected} rejected` : undefined,
    undecided > 0 ? `${undecided} undecided` : undefined,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' and ')} won't be posted.` : undefined;
}

/** Findings without a line can only go in the review body, so they are not inline comments. */
function describePost(
  findingCount: number,
  accepted: ReadonlyArray<ReviewFinding>,
  counts: DecisionCounts,
): string {
  if (findingCount === 0) {
    return 'This submits one GitHub review with the summary and no findings.';
  }
  const leftOut = describeLeftOut(counts);
  if (accepted.length === 0) {
    return [
      'No findings are accepted, so this posts a GitHub review with only the summary.',
      leftOut,
    ].join(' ');
  }
  const inlineCount = accepted.filter((finding) => finding.line !== undefined).length;
  const bodyCount = accepted.length - inlineCount;
  const which =
    accepted.length < findingCount
      ? `${accepted.length} of ${plural(findingCount, 'finding')}`
      : findingCount === 1
        ? 'the only finding'
        : `all ${findingCount} findings`;
  const where =
    bodyCount === 0
      ? `, as ${inlineCount === 1 ? 'an inline comment' : 'inline comments'}`
      : inlineCount === 0
        ? ', in the review body'
        : `: ${inlineCount} as inline ${inlineCount === 1 ? 'comment' : 'comments'} and ${bodyCount} in the review body`;
  return [`Posting ${which} in one GitHub review${where}.`, leftOut].filter(Boolean).join(' ');
}

/** The loot screen for a finished run: the agent's summary, verdict and findings, and what to do with them. */
export const ReviewResult = ({
  run,
  quest = undefined,
  onClickClose,
  onDecide,
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
  const [unsaved, setUnsaved] = useState<UnsavedDecisions>(NOTHING_UNSAVED);
  const [isHidingRejected, setIsHidingRejected] = useState(false);
  const summary = quest ?? run.quest;
  const label = questLabel(summary);
  const findings = result?.findings ?? [];
  const groups = groupFindings(findings);
  const findingIndex = new Map(findings.map((finding, index) => [finding, index]));
  const findingCount = findings.length;
  const isAwaitingDecision = run.disposition === 'pending';
  // Runs posted before decisions existed posted every finding, so they show no decisions at all.
  const showsDecisions =
    findingCount > 0 && (isAwaitingDecision || run.findingDecisions !== undefined);
  const canDecide = isAwaitingDecision && pending === undefined;
  const decisions = findingDecisionsOf(run).map(
    (decision, index) => unsaved.decisions.get(index) ?? decision,
  );
  const counts = countDecisions(decisions);
  const acceptedIndexes = decisions.flatMap((decision, index) =>
    decision === 'accepted' ? [index] : [],
  );
  const accepted = acceptedIndexes.flatMap((index) => findings[index] ?? []);
  const allIndexes = findings.map((_finding, index) => index);
  const isHidden = (index: number): boolean =>
    showsDecisions && isHidingRejected && decisions[index] === 'rejected';
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      findings: group.findings.filter((finding) => !isHidden(findingIndex.get(finding) ?? -1)),
    }))
    .filter((group) => group.findings.length > 0);

  const runAction = (action: Pending, request: () => Promise<void>): void => {
    setPending(action);
    setError(undefined);
    request().catch((reason: unknown) => {
      setError(describeError(reason));
      setPending(undefined);
    });
  };

  const decide = (findingIndexes: Array<number>, decision: FindingDecision): void => {
    setError(undefined);
    setUnsaved((current) => {
      const next = new Map(current.decisions);
      for (const index of findingIndexes) {
        next.set(index, decision);
      }
      return { decisions: next, saving: current.saving + 1 };
    });
    void onDecide(findingIndexes, decision)
      .catch((reason: unknown) => setError(describeError(reason)))
      .finally(() =>
        setUnsaved((current) =>
          current.saving <= 1 ? NOTHING_UNSAVED : { ...current, saving: current.saving - 1 },
        ),
      );
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
            {showsDecisions ? (
              <div className="decisions">
                <p className="decisions__summary" role="status">
                  {`${counts.accepted} accepted · ${counts.rejected} rejected · ${counts.undecided} undecided`}
                </p>
                <div className="decisions__actions">
                  {isAwaitingDecision ? (
                    <div aria-label="Decide on every finding" className="button-row" role="group">
                      <button
                        className="button button--small"
                        disabled={!canDecide || counts.accepted === findingCount}
                        onClick={() => decide(allIndexes, 'accepted')}
                        type="button"
                      >
                        <span aria-hidden="true">✓</span> Accept all
                      </button>
                      <button
                        className="button button--small"
                        disabled={!canDecide || counts.rejected === findingCount}
                        onClick={() => decide(allIndexes, 'rejected')}
                        type="button"
                      >
                        <span aria-hidden="true">✕</span> Reject all
                      </button>
                      <button
                        className="button button--small"
                        disabled={!canDecide || counts.undecided === findingCount}
                        onClick={() => decide(allIndexes, 'undecided')}
                        type="button"
                      >
                        <span aria-hidden="true">↺</span> Reset
                      </button>
                    </div>
                  ) : null}
                  {counts.rejected > 0 || isHidingRejected ? (
                    <button
                      aria-pressed={isHidingRejected}
                      className="button button--small switch"
                      onClick={() => setIsHidingRejected(!isHidingRejected)}
                      type="button"
                    >
                      <span aria-hidden="true" className="switch__box">
                        {isHidingRejected ? '■' : '□'}
                      </span>
                      Hide rejected
                    </button>
                  ) : null}
                </div>
                {isAwaitingDecision ? (
                  <p className="muted">
                    Only accepted findings are posted. Rejected and undecided ones stay here.
                  </p>
                ) : null}
                {isHidingRejected && counts.rejected > 0 ? (
                  <p className="muted">{plural(counts.rejected, 'rejected finding')} hidden.</p>
                ) : null}
              </div>
            ) : null}
            {groups.length === 0 ? (
              <p className="board-state board-state--victory">No findings. A flawless victory.</p>
            ) : (
              visibleGroups.map((group) => (
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
                    {group.findings.map((finding) => {
                      const index = findingIndex.get(finding) ?? -1;
                      const decision = decisions[index] ?? 'undecided';
                      const location =
                        finding.line === undefined
                          ? finding.file
                          : `${finding.file}:${finding.line}`;
                      return (
                        <li
                          className={[
                            'finding',
                            showsDecisions ? `finding--${decision}` : undefined,
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          key={index}
                        >
                          <div className="finding__head">
                            <code className="finding__location">{location}</code>
                            {showsDecisions ? (
                              <FindingDecisionToggle
                                decision={decision}
                                isDisabled={!canDecide}
                                location={location}
                                onChange={(next) => decide([index], next)}
                              />
                            ) : null}
                          </div>
                          <p className="prewrap finding__body">{finding.body}</p>
                        </li>
                      );
                    })}
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
            {describePost(findingCount, accepted, counts)}{' '}
            {accepted.some((finding) => finding.line !== undefined)
              ? 'If GitHub rejects a line, every posted finding goes in the body instead. '
              : null}
            It also shows up in Linear.
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
              onClick={() => runAction('post', () => onPost(postEvent, acceptedIndexes))}
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
