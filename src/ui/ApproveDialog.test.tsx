// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ApproveDialog } from './ApproveDialog.tsx';
import { makeQuest } from './test-utils/fixtures.ts';

describe('ApproveDialog', () => {
  afterEach(cleanup);

  test('names the PR and only approves on explicit confirmation', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    render(<ApproveDialog onClickClose={vi.fn()} onConfirm={onConfirm} quest={makeQuest()} />);

    const dialog = screen.getByRole('dialog', { name: 'Approve this PR?' });
    expect(dialog.textContent).toContain('Trackunit/manager#101');
    expect(dialog.textContent).toContain('Add the fleet health widget');
    expect(onConfirm).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/Approval comment/), 'LGTM');
    await user.click(screen.getByRole('button', { name: 'Approve Trackunit/manager#101' }));
    expect(onConfirm).toHaveBeenCalledWith('LGTM');
  });

  test('cancel and Escape close without approving', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    const onClickClose = vi.fn();
    render(<ApproveDialog onClickClose={onClickClose} onConfirm={onConfirm} quest={makeQuest()} />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClickClose).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test('shows a failed approval and stays open', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.reject(new Error('Linear said no')));
    render(<ApproveDialog onClickClose={vi.fn()} onConfirm={onConfirm} quest={makeQuest()} />);

    await user.click(screen.getByRole('button', { name: 'Approve Trackunit/manager#101' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Linear said no');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
