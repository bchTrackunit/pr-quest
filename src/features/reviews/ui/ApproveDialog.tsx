import { useId, useState, type FormEvent } from 'react';

import type { Quest } from '../../../shared/api.ts';
import { ApiRequestError, describeError } from '../../../platform/ui/apiClient.ts';
import { questLabel } from '../../game/ui/gameState.ts';
import { Modal } from '../../../platform/ui/Modal.tsx';

export interface ApproveDialogProps {
  quest: Quest;
  /** `headSha` is the commit shown in the dialog; the approval is pinned to it. */
  onConfirm: (comment: string, headSha: string) => Promise<void>;
  onClickClose: () => void;
}

const SHORT_SHA_LENGTH = 7;

function describeApprovalError(reason: unknown): string {
  const message = describeError(reason);
  return reason instanceof ApiRequestError && reason.code === 'headChanged'
    ? message
    : `Approval failed: ${message}`;
}

/** The only path to approving a PR: it names the PR and commit and waits for an explicit confirmation. */
export const ApproveDialog = ({ quest, onConfirm, onClickClose }: ApproveDialogProps) => {
  const [comment, setComment] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const commentId = useId();
  const { headSha } = quest;

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!headSha) {
      return;
    }
    setIsPending(true);
    setError(undefined);
    onConfirm(comment, headSha).catch((reason: unknown) => {
      setError(describeApprovalError(reason));
      setIsPending(false);
    });
  };

  return (
    <Modal isBusy={isPending} onClickClose={onClickClose} title="Approve this PR?">
      <form className="stack" onSubmit={handleSubmit}>
        <p>
          You are about to approve <strong>{questLabel(quest)}</strong>:
        </p>
        <p className="approve__title">{quest.title}</p>
        <p className="muted">
          by {quest.author.name} · +{quest.diffStats.additions} −{quest.diffStats.deletions} in{' '}
          {quest.diffStats.fileCount} files
          {headSha ? (
            <>
              {' '}
              at commit <code>{headSha.slice(0, SHORT_SHA_LENGTH)}</code>
            </>
          ) : null}
        </p>
        {headSha ? null : (
          <p className="form-error">
            The head commit of this PR is unknown. Refresh the board before approving.
          </p>
        )}
        <label className="field" htmlFor={commentId}>
          <span className="field__label">Approval comment (optional)</span>
          <textarea
            className="field__input"
            disabled={isPending}
            id={commentId}
            onChange={(event) => setComment(event.target.value)}
            rows={3}
            value={comment}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row button-row--end">
          <button
            className="button"
            data-autofocus
            disabled={isPending}
            onClick={onClickClose}
            type="button"
          >
            Cancel
          </button>
          <button className="button button--success" disabled={isPending || !headSha} type="submit">
            {isPending ? 'Approving…' : `Approve ${questLabel(quest)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
};
