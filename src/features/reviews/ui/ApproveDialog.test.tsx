// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ApiRequestError } from '../../../platform/ui/apiClient.ts';
import { ApproveDialog } from './ApproveDialog.tsx';
import { makeQuest } from '../../../platform/ui/test-utils/fixtures.ts';

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
    expect(onConfirm).toHaveBeenCalledWith('LGTM', '0123456789abcdef0123456789abcdef01234567');
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

  test('names the commit that will be approved', () => {
    render(<ApproveDialog onClickClose={vi.fn()} onConfirm={vi.fn()} quest={makeQuest()} />);

    expect(screen.getByRole('dialog').textContent).toContain('at commit 0123456');
  });

  test('asks to re-check when new commits were pushed, and stays open', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() =>
      Promise.reject(new ApiRequestError(409, 'headChanged', 'New commits were pushed')),
    );
    render(<ApproveDialog onClickClose={vi.fn()} onConfirm={onConfirm} quest={makeQuest()} />);

    await user.click(screen.getByRole('button', { name: 'Approve Trackunit/manager#101' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'New commits were pushed to this PR. Re-check them before approving.',
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('cannot approve while the head commit is unknown', () => {
    render(
      <ApproveDialog
        onClickClose={vi.fn()}
        onConfirm={vi.fn()}
        quest={makeQuest({ headSha: undefined })}
      />,
    );

    expect(screen.getByRole('button', { name: 'Approve Trackunit/manager#101' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('dialog').textContent).toContain('Refresh the board');
  });
});
