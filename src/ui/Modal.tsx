import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  onClickClose: () => void;
  /** Extra class for the panel, e.g. a wider layout. */
  className?: string;
  /** Blocks closing while a request is in flight. */
  isBusy?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal dialog that traps focus, closes on Escape and restores focus to its opener. */
export const Modal = ({
  title,
  children,
  onClickClose,
  className = '',
  isBusy = false,
}: ModalProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>('[data-autofocus]');
    (preferred ?? panel)?.focus();
    return () => opener?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!isBusy) {
        onClickClose();
      }
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) {
      return;
    }
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop" onKeyDown={handleKeyDown} role="presentation">
      <div
        aria-busy={isBusy}
        aria-labelledby={titleId}
        aria-modal="true"
        className={['modal', className].filter(Boolean).join(' ')}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="modal__header">
          <h2 className="modal__title pixel" id={titleId}>
            {title}
          </h2>
          <button
            aria-label="Close"
            className="icon-button"
            disabled={isBusy}
            onClick={onClickClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
};
