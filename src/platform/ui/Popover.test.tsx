// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Modal } from './Modal.tsx';
import { Popover, usePopoverClose } from './Popover.tsx';

const CloseButton = () => {
  const close = usePopoverClose();
  return (
    <button onClick={close} type="button">
      Done
    </button>
  );
};

/** A panel whose only control unmounts when clicked, dropping focus to the body. */
const Vanishing = () => {
  const [isGone, setIsGone] = useState(false);
  return isGone ? (
    <p>Gone</p>
  ) : (
    <button onClick={() => setIsGone(true)} type="button">
      Vanish
    </button>
  );
};

function renderPopover(children = <CloseButton />) {
  render(
    <>
      <button type="button">Outside</button>
      <Popover buttonContent="Menu" label="Example menu">
        {children}
      </Popover>
    </>,
  );
  return screen.getByRole('button', { name: 'Menu' });
}

describe('Popover', () => {
  afterEach(cleanup);

  test('opens on click, reports it and focuses the first control', async () => {
    const user = userEvent.setup();
    const toggle = renderPopover();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(toggle);

    const panel = screen.getByRole('dialog', { name: 'Example menu' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }));
  });

  test('a toggle tooltip describes the button and hides while the panel is open', async () => {
    const user = userEvent.setup();
    render(
      <Popover buttonContent="☰" buttonLabel="Menu" buttonTooltip="More options" label="Example">
        <CloseButton />
      </Popover>,
    );
    const toggle = screen.getByRole('button', { name: 'Menu' });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(toggle.getAttribute('aria-describedby')).toBe(tooltip.id);

    await user.hover(toggle);
    expect(screen.getByRole('tooltip').textContent).toBe('More options');

    await user.click(toggle);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('tooltip').textContent).toBe('More options');
  });

  test('Escape closes it and returns focus to the toggle', async () => {
    const user = userEvent.setup();
    const toggle = renderPopover();
    await user.click(toggle);

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  test('Escape still closes it after the focused control unmounts', async () => {
    const user = userEvent.setup();
    const toggle = renderPopover(<Vanishing />);
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Vanish' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  test('usePopoverClose closes it from inside and returns focus', async () => {
    const user = userEvent.setup();
    const toggle = renderPopover();
    await user.click(toggle);

    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  test('clicking outside or tabbing away closes it without pulling focus back', async () => {
    const user = userEvent.setup();
    const toggle = renderPopover();
    await user.click(toggle);

    await user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));

    await user.click(toggle);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(toggle);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.tab({ shift: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a modal opened from the panel takes focus, closing it, and gets the Escape', async () => {
    const user = userEvent.setup();
    const onClickClose = vi.fn();
    const Harness = () => {
      const [isModalOpen, setIsModalOpen] = useState(false);
      return (
        <>
          <Popover buttonContent="Menu" label="Example menu">
            <button onClick={() => setIsModalOpen(true)} type="button">
              Open dialog
            </button>
          </Popover>
          {isModalOpen ? (
            <Modal onClickClose={onClickClose} title="Example dialog">
              <p>Body</p>
            </Modal>
          ) : null}
        </>
      );
    };
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(screen.queryByRole('dialog', { name: 'Example menu' })).toBeNull();

    await user.keyboard('{Escape}');

    expect(onClickClose).toHaveBeenCalledTimes(1);
  });
});
