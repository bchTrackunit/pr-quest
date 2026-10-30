import { useId, useState, type FormEvent } from 'react';

import type { Quest } from '../shared/api.ts';
import { describeError } from './apiClient.ts';
import { questLabel } from './gameState.ts';
import { Modal } from './Modal.tsx';

export interface ApproveDialogProps {
  quest: Quest;
  onConfirm: (comment: string) => Promise<void>;
  onClickClose: () => void;
}

/** The only path to approving a PR: it names the PR and waits for an explicit confirmation. */
export const ApproveDialog = ({ quest, onConfirm, onClickClose }: ApproveDialogProps) => {
  const [comment, setComment] = useState('');
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const commentId = useId();

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setIsPending(true);
    setError(undefined);
    onConfirm(comment).catch((reason: unknown) => {
      setError(describeError(reason));
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
        </p>
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
            Approval failed: {error}
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
          <button className="button button--success" disabled={isPending} type="submit">
            {isPending ? 'Approving…' : `Approve ${questLabel(quest)}`}
          </button>
        </div>
      </form>
    </Modal>
  );
};
