import type { Toast } from './gameState.ts';
import { ToastItem } from './ToastItem.tsx';

export interface ToastsProps {
  toasts: Array<Toast>;
  onDismiss: (toastId: string) => void;
  onClickOpenResult: (runId: string) => void;
}

/**
 * Two live regions: errors interrupt (`assertive`), everything else waits its turn (`polite`).
 * The regions stay mounted even when empty so screen readers pick up the first toast.
 */
export const Toasts = ({ toasts, onDismiss, onClickOpenResult }: ToastsProps) => {
  const errors = toasts.filter((toast) => toast.kind === 'error');
  const others = toasts.filter((toast) => toast.kind !== 'error');
  return (
    <div className="toasts">
      <ul
        aria-label="Notifications"
        aria-live="polite"
        aria-relevant="additions"
        className="toasts__list"
      >
        {others.map((toast) => (
          <ToastItem
            key={toast.id}
            onClickOpenResult={onClickOpenResult}
            onDismiss={onDismiss}
            toast={toast}
          />
        ))}
      </ul>
      <ul
        aria-label="Errors"
        aria-live="assertive"
        aria-relevant="additions"
        className="toasts__list"
      >
        {errors.map((toast) => (
          <ToastItem
            key={toast.id}
            onClickOpenResult={onClickOpenResult}
            onDismiss={onDismiss}
            toast={toast}
          />
        ))}
      </ul>
    </div>
  );
};
