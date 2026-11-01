import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react';

import { FOCUSABLE, isModalOpen } from './Modal.tsx';
import { Tooltip } from './Tooltip.tsx';

export interface PopoverProps {
  /** The panel's accessible name. */
  label: string;
  /** What the toggle button shows; its text is the button's name unless `buttonLabel` is set. */
  buttonContent: ReactNode;
  /** The toggle button's accessible name; must include its visible text. */
  buttonLabel?: string;
  /** A tooltip for the toggle button, hidden while the panel is open. */
  buttonTooltip?: string;
  buttonClassName?: string;
  /** Extra class for the panel. */
  className?: string;
  /** The edge of the toggle button the panel lines up with. */
  align?: 'start' | 'end';
  children: ReactNode;
}

const PopoverCloseContext = createContext<() => void>(() => undefined);

/** Closes the enclosing popover and returns focus to its toggle button. */
export function usePopoverClose(): () => void {
  return useContext(PopoverCloseContext);
}

/**
 * A non-modal panel that drops down from a toggle button. Opening it focuses the panel's
 * `data-autofocus` target or first control. Escape closes it and returns focus to the button;
 * clicking or tabbing outside closes it without moving focus. Escape is handled on `document`,
 * like `Modal`, so it still works after the focused control unmounts.
 */
export const Popover = ({
  label,
  buttonContent,
  buttonLabel = undefined,
  buttonTooltip = undefined,
  buttonClassName = 'button',
  className = '',
  align = 'start',
  children,
}: PopoverProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setIsOpen(false);
    buttonRef.current?.focus();
  }, []);

  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !event.defaultPrevented && !isModalOpen()) {
      event.preventDefault();
      close();
    }
  });

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const panel = panelRef.current;
    (
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel
    )?.focus();

    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [isOpen]);

  // Focus dropping to the body (an unmounted control) has no relatedTarget and keeps it open.
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) {
      setIsOpen(false);
    }
  };

  const renderButton = (describedBy?: string) => (
    <button
      aria-controls={isOpen ? panelId : undefined}
      aria-describedby={describedBy}
      aria-expanded={isOpen}
      aria-haspopup="dialog"
      aria-label={buttonLabel}
      className={buttonClassName}
      onClick={() => (isOpen ? close() : setIsOpen(true))}
      ref={buttonRef}
      type="button"
    >
      {buttonContent}
    </button>
  );

  return (
    <div className="popover" onBlur={onBlur} ref={rootRef}>
      {buttonTooltip ? (
        <Tooltip align={align} content={buttonTooltip} isDisabled={isOpen}>
          {renderButton}
        </Tooltip>
      ) : (
        renderButton()
      )}
      {isOpen ? (
        <div
          aria-label={label}
          className={['popover__panel', `popover__panel--${align}`, className]
            .filter(Boolean)
            .join(' ')}
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <PopoverCloseContext value={close}>{children}</PopoverCloseContext>
        </div>
      ) : null}
    </div>
  );
};
