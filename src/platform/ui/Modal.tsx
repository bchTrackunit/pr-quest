import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react';

import { Tooltip } from './Tooltip.tsx';

export interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  onClickClose: () => void;
  /** Extra class for the panel, e.g. a wider layout. */
  className?: string;
  /** Blocks closing while a request is in flight. */
  isBusy?: boolean;
  /** Where focus goes on close when the opener has left the page, e.g. it was replaced. */
  returnFocusTo?: () => HTMLElement | null | undefined;
}

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open panels, newest last; only the top one handles keys and focus. */
const openPanels: Array<HTMLElement> = [];

/** True while any modal is open; popovers leave Escape to it. */
export function isModalOpen(): boolean {
  return openPanels.length > 0;
}

/**
 * True while nothing in the top dialog has taken focus since it opened: focus is still on the
 * panel, on its `data-autofocus` target, or nowhere. Lets late-mounting content focus itself
 * without stealing focus the player already moved.
 */
export function isDialogFocusUnclaimed(): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) {
    return true;
  }
  const panel = openPanels.at(-1);
  return active === panel || (!!panel?.contains(active) && active.hasAttribute('data-autofocus'));
}

/**
 * A modal dialog that traps focus, closes on Escape and restores focus to its opener. Keys are
 * handled on `document`, because the focused control can unmount or disable, which drops focus
 * to the body where a listener on the dialog would never hear them.
 */
export const Modal = ({
  title,
  children,
  onClickClose,
  className = '',
  isBusy = false,
  returnFocusTo,
}: ModalProps) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const handleKeyDown = useEffectEvent((event: KeyboardEvent, panel: HTMLElement): void => {
    if (event.key === 'Escape') {
      if (!event.defaultPrevented && !isBusy) {
        event.preventDefault();
        onClickClose();
      }
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const active = document.activeElement;
    if (!active || !panel.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  });

  const fallbackFocus = useEffectEvent(() => returnFocusTo?.());

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return undefined;
    }
    const opener =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : undefined;
    openPanels.push(panel);
    const isTop = (): boolean => openPanels.at(-1) === panel;
    (panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTop()) {
        handleKeyDown(event, panel);
      }
    };
    // Unmounting or disabling the focused control moves focus to the body without a focus event.
    const observer = new MutationObserver(() => {
      const active = document.activeElement;
      if (isTop() && (!active || !panel.contains(active))) {
        panel.focus();
      }
    });
    document.addEventListener('keydown', onKeyDown);
    observer.observe(panel, {
      attributeFilter: ['disabled'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      observer.disconnect();
      openPanels.splice(openPanels.indexOf(panel), 1);
      const target = opener?.isConnected ? opener : fallbackFocus();
      target?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation">
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
          <Tooltip align="end" content="Close (Esc)">
            {(describedBy) => (
              <button
                aria-describedby={describedBy}
                aria-label="Close"
                className="icon-button"
                disabled={isBusy}
                onClick={onClickClose}
                type="button"
              >
                ✕
              </button>
            )}
          </Tooltip>
        </header>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
};
