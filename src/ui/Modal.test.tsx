// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Modal } from './Modal.tsx';

describe('Modal', () => {
  afterEach(cleanup);

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
});
