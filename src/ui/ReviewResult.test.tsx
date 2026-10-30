// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Quest, ReviewRun } from '../shared/api.ts';
import { ReviewResult } from './ReviewResult.tsx';
import { makeQuest, makeResult, makeRun } from './test-utils/fixtures.ts';

function renderResult(
  run: ReviewRun = makeRun({ status: 'finished', result: makeResult() }),
  /** `null` renders the result for a quest that is no longer in the queue. */
  quest: Quest | null = makeQuest(),
) {
  const handlers = {
    onClickClose: vi.fn(),
    onPost: vi.fn(() => Promise.resolve()),
    onDiscard: vi.fn(() => Promise.resolve()),
    onClickApprove: vi.fn(),
  };
  render(<ReviewResult quest={quest ?? undefined} run={run} {...handlers} />);
  return handlers;
}

describe('ReviewResult', () => {
  afterEach(cleanup);

  test('shows the summary, verdict and findings grouped by severity with file:line', () => {
    renderResult();
    const dialog = screen.getByRole('dialog', { name: 'Loot from Trackunit/manager#101' });
    expect(dialog.textContent).toContain('Solid change with one risky query.');
    expect(dialog.textContent).toContain('Agent verdict: Comments');

    const groups = screen
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent);
    expect(groups).toEqual([
      expect.stringContaining('Critical'),
      expect.stringContaining('Minor'),
      expect.stringContaining('Nit'),
    ]);
    const critical = screen.getByRole('region', { name: /Critical/ });
    expect(within(critical).getByText('src/query.ts:40')).toBeTruthy();
    expect(screen.getByText('README.md')).toBeTruthy();
  });

  test('posts only after confirmation, with the chosen review event', async () => {
    const user = userEvent.setup();
    const handlers = renderResult();

    await user.click(screen.getByRole('button', { name: 'Post to PR' }));
    expect(handlers.onPost).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: 'Post to Trackunit/manager#101?' })).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Confirm post' }));
    expect(handlers.onPost).toHaveBeenCalledWith('requestChanges');
  });

  test('cancelling the post confirmation returns to the actions', async () => {
    const user = userEvent.setup();
    const handlers = renderResult();
    await user.click(screen.getByRole('button', { name: 'Post to PR' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Post to PR' })).toBeTruthy();
    expect(handlers.onPost).not.toHaveBeenCalled();
  });

  test('discards, approves and links to Linear', async () => {
    const user = userEvent.setup();
    const handlers = renderResult();
    expect(screen.getByRole('link', { name: /Open in Linear/ }).getAttribute('href')).toBe(
      'https://linear.app/trackunit/review/manager-101',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(handlers.onClickApprove).toHaveBeenCalledWith('Trackunit/manager#101');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(handlers.onDiscard).toHaveBeenCalled();
  });

  test('names the quest from the run once it has left the queue, without offering Approve', () => {
    renderResult(makeRun({ status: 'finished', result: makeResult() }), null);

    expect(screen.getByRole('dialog', { name: 'Loot from Trackunit/manager#101' })).toBeTruthy();
    expect(screen.getByText('Add the fleet health widget')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Open in Linear/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  test('shows a failed post', async () => {
    const user = userEvent.setup();
    const handlers = renderResult();
    handlers.onPost.mockImplementationOnce(() => Promise.reject(new Error('gh api failed')));
    await user.click(screen.getByRole('button', { name: 'Post to PR' }));
    await user.click(screen.getByRole('button', { name: 'Confirm post' }));
    expect((await screen.findByRole('alert')).textContent).toContain('gh api failed');
  });

  test('hides post and discard once the findings were posted', () => {
    renderResult(
      makeRun({
        status: 'finished',
        disposition: 'posted',
        result: makeResult(),
        postedReviewUrl: 'https://github.com/Trackunit/manager/pull/101#pullrequestreview-1',
      }),
    );
    expect(screen.queryByRole('button', { name: 'Post to PR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.getByRole('link', { name: 'View the review on GitHub' })).toBeTruthy();
  });
});
