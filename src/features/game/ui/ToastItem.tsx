import { useEffect, useState } from 'react';

import { Tooltip } from '../../../platform/ui/Tooltip.tsx';
import type { Toast } from './gameState.ts';

export interface ToastItemProps {
  toast: Toast;
  onDismiss: (toastId: string) => void;
  onClickOpenResult: (runId: string) => void;
}

const DURATION_MS: Record<Toast['kind'], number> = {
  loot: 12_000,
  achievement: 8000,
  success: 6000,
  error: 10_000,
};

/** One toast. It dismisses itself after a while, but never while hovered or focused. */
export const ToastItem = ({ toast, onDismiss, onClickOpenResult }: ToastItemProps) => {
  const [isPaused, setIsPaused] = useState(false);
  const { id, kind } = toast;

  useEffect(() => {
    if (isPaused) {
      return undefined;
    }
    const timer = setTimeout(() => onDismiss(id), DURATION_MS[kind]);
    return () => clearTimeout(timer);
  }, [id, kind, isPaused, onDismiss]);

  const { runId } = toast;
  const dismiss = (): void => onDismiss(id);

  return (
    <li
      className={['toast', `toast--${toast.kind}`].join(' ')}
      onBlur={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      {toast.icon ? (
        <span aria-hidden="true" className="toast__icon">
          {toast.icon}
        </span>
      ) : null}
      <div className="toast__text">
        <p className="toast__title">{toast.title}</p>
        {toast.message ? <p className="toast__message">{toast.message}</p> : null}
        {runId ? (
          <button
            className="button button--loot button--small"
            onClick={() => {
              onClickOpenResult(runId);
              dismiss();
            }}
            type="button"
          >
            View loot
          </button>
        ) : null}
        {toast.href ? (
          <a href={toast.href} rel="noopener noreferrer" target="_blank">
            View on GitHub
          </a>
        ) : null}
      </div>
      <Tooltip align="end" content="Dismiss" side="top">
        {(describedBy) => (
          <button
            aria-describedby={describedBy}
            aria-label="Dismiss notification"
            className="icon-button"
            onClick={dismiss}
            type="button"
          >
            ✕
          </button>
        )}
      </Tooltip>
    </li>
  );
};
