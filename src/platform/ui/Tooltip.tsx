import {
  useEffect,
  useEffectEvent,
  useId,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

export interface TooltipProps {
  /** What the tooltip says. */
  content: string;
  /** Renders the trigger; put `describedBy` on its focusable element as `aria-describedby`. */
  children: (describedBy: string) => ReactNode;
  /** The edge of the trigger the tooltip lines up with. */
  align?: 'center' | 'start' | 'end';
  /** Which side of the trigger the tooltip shows on. */
  side?: 'bottom' | 'top';
  /** Keeps it hidden, e.g. while the trigger's own popover is open. */
  isDisabled?: boolean;
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * A short label for an icon-only control. It shows while the mouse hovers the trigger or the
 * trigger has keyboard focus, and Escape dismisses it without moving focus. Pressing the trigger hides it
 * until the pointer comes back, so it never covers what the click opened. It stays in the DOM
 * while hidden so `aria-describedby` always resolves.
 */
export const Tooltip = ({
  content,
  children,
  align = 'center',
  side = 'bottom',
  isDisabled = false,
}: TooltipProps) => {
  const id = useId();
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const isVisible = (isHovered || isFocused) && !isDismissed && !isDisabled;

  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      setIsDismissed(true);
    }
  });

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isVisible]);

  const onPointerEnter = (event: PointerEvent<HTMLSpanElement>): void => {
    if (event.pointerType === 'mouse') {
      setIsHovered(true);
      setIsDismissed(false);
    }
  };

  // Only keyboard focus shows it; a mouse press already had its hover, and Safari never focuses
  // buttons on click at all, so a press has to be cleared by the next keyboard focus instead.
  const onFocus = (event: FocusEvent<HTMLSpanElement>): void => {
    if (isFocusVisible(event.target)) {
      setIsFocused(true);
      setIsDismissed(false);
    }
  };

  const onBlur = (event: FocusEvent<HTMLSpanElement>): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Node && event.currentTarget.contains(next))) {
      setIsFocused(false);
      setIsDismissed(false);
    }
  };

  return (
    <span
      className="tooltip"
      onBlur={onBlur}
      onFocus={onFocus}
      onPointerDown={() => setIsDismissed(true)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={() => setIsHovered(false)}
    >
      {children(id)}
      <span
        className={[
          'tooltip__bubble',
          `tooltip__bubble--${align}`,
          `tooltip__bubble--${side}`,
        ].join(' ')}
        hidden={!isVisible}
        id={id}
        role="tooltip"
      >
        {content}
      </span>
    </span>
  );
};
