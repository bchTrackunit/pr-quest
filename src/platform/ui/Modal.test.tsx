// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Modal } from './Modal.tsx';

/** A dialog whose only control unmounts when clicked, like "Cancel" turning into "Try again". */
const Vanishing = ({ onClickClose }: { onClickClose: () => void }) => {
  const [isGone, setIsGone] = useState(false);
  return (
    <Modal onClickClose={onClickClose} title="Example">
      {isGone ? (
        <p>Gone</p>
      ) : (
        <button data-autofocus onClick={() => setIsGone(true)} type="button">
          Vanish
        </button>
      )}
    </Modal>
  );
};

describe('Modal', () => {
  afterEach(cleanup);

  test('the ✕ button is labelled Close and has a tooltip', async () => {
    const user = userEvent.setup();
    render(
      <Modal onClickClose={vi.fn()} title="Example">
        <p>Body</p>
      </Modal>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(close.getAttribute('aria-describedby')).toBe(tooltip.id);

    await user.hover(close);
    expect(screen.getByRole('tooltip').textContent).toBe('Close (Esc)');
  });

  test('Shift+Tab from the panel itself wraps to the last control', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Modal onClickClose={vi.fn()} title="Example">
          <button type="button">Inside</button>
        </Modal>
      </>,
    );

    expect(document.activeElement).toBe(screen.getByRole('dialog'));
    await user.tab({ shift: true });

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Inside' }));
  });

  test('Tab from the last control wraps to the first', async () => {
    const user = userEvent.setup();
    render(
      <Modal onClickClose={vi.fn()} title="Example">
        <button type="button">Inside</button>
      </Modal>,
    );

    screen.getByRole('button', { name: 'Inside' }).focus();
    await user.tab();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  test('when the focused control unmounts, focus returns to the panel and Escape still closes', async () => {
    const user = userEvent.setup();
    const onClickClose = vi.fn();
    render(<Vanishing onClickClose={onClickClose} />);

    await user.click(screen.getByRole('button', { name: 'Vanish' }));

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('dialog')));
    await user.keyboard('{Escape}');
    expect(onClickClose).toHaveBeenCalledTimes(1);
  });

  test('Escape and Tab work even when focus has left the panel', async () => {
    const user = userEvent.setup();
    const onClickClose = vi.fn();
    render(
      <>
        <button type="button">Outside</button>
        <Modal onClickClose={onClickClose} title="Example">
          <button type="button">Inside</button>
        </Modal>
      </>,
    );

    screen.getByRole('button', { name: 'Outside' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Escape}');
    expect(onClickClose).toHaveBeenCalledTimes(1);
  });

  test('Escape is ignored while busy', async () => {
    const user = userEvent.setup();
    const onClickClose = vi.fn();
    render(
      <Modal isBusy onClickClose={onClickClose} title="Example">
        <p>Saving</p>
      </Modal>,
    );

    await user.keyboard('{Escape}');
    expect(onClickClose).not.toHaveBeenCalled();
  });

  test('only the top dialog of a stack handles Escape', async () => {
    const user = userEvent.setup();
    const closeBottom = vi.fn();
    const closeTop = vi.fn();
    render(
      <>
        <Modal onClickClose={closeBottom} title="Bottom">
          <p>Below</p>
        </Modal>
        <Modal onClickClose={closeTop} title="Top">
          <p>Above</p>
        </Modal>
      </>,
    );

    await user.keyboard('{Escape}');
    expect(closeTop).toHaveBeenCalledTimes(1);
    expect(closeBottom).not.toHaveBeenCalled();
  });

  test('returns focus to the fallback when the opener has left the page', async () => {
    const user = userEvent.setup();
    const Harness = () => {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <>
          {isOpen ? null : (
            <button onClick={() => setIsOpen(true)} type="button">
              Open
            </button>
          )}
          <button type="button">Fallback</button>
          {isOpen ? (
            <Modal
              onClickClose={() => setIsOpen(false)}
              returnFocusTo={() => screen.getByRole('button', { name: 'Fallback' })}
              title="Example"
            >
              <p>Body</p>
            </Modal>
          ) : null}
        </>
      );
    };
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Fallback' }));
  });
});
