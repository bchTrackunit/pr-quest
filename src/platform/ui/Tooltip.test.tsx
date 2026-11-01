// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';

import { Tooltip } from './Tooltip.tsx';

function renderTooltip(isDisabled = false) {
  render(
    <>
      <Tooltip content="Dismiss notification" isDisabled={isDisabled}>
        {(describedBy) => (
          <button aria-describedby={describedBy} aria-label="Dismiss" type="button">
            ✕
          </button>
        )}
      </Tooltip>
      <button type="button">Elsewhere</button>
    </>,
  );
  return screen.getByRole('button', { name: 'Dismiss' });
}

function visibleTooltip(): HTMLElement | null {
  return screen.queryByRole('tooltip');
}

describe('Tooltip', () => {
  afterEach(cleanup);

  test('describes its trigger even while hidden', () => {
    const trigger = renderTooltip();
    const tooltip = screen.getByRole('tooltip', { hidden: true });

    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(tooltip.textContent).toBe('Dismiss notification');
    expect(visibleTooltip()).toBeNull();
  });

  test('shows on hover and hides when the pointer leaves', async () => {
    const user = userEvent.setup();
    const trigger = renderTooltip();

    await user.hover(trigger);
    expect(visibleTooltip()?.textContent).toBe('Dismiss notification');

    await user.unhover(trigger);
    expect(visibleTooltip()).toBeNull();
  });

  test('shows on keyboard focus and hides on blur', async () => {
    const user = userEvent.setup();
    renderTooltip();

    await user.tab();
    expect(visibleTooltip()).not.toBeNull();

    await user.tab();
    expect(visibleTooltip()).toBeNull();
  });

  test('Escape dismisses it without moving focus', async () => {
    const user = userEvent.setup();
    const trigger = renderTooltip();

    await user.tab();
    await user.keyboard('{Escape}');
    expect(visibleTooltip()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test('clicking the trigger hides it until the pointer comes back', async () => {
    const user = userEvent.setup();
    const trigger = renderTooltip();

    await user.click(trigger);
    expect(visibleTooltip()).toBeNull();

    await user.unhover(trigger);
    await user.hover(trigger);
    expect(visibleTooltip()).not.toBeNull();
  });

  test('stays hidden while disabled', async () => {
    const user = userEvent.setup();
    const trigger = renderTooltip(true);

    await user.hover(trigger);
    expect(visibleTooltip()).toBeNull();
  });
});
