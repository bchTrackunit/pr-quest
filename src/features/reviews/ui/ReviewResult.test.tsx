// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Quest, ReviewRun } from '../../../shared/api.ts';
import { ReviewResult } from './ReviewResult.tsx';
import { makeQuest, makeResult, makeRun } from '../../../platform/ui/test-utils/fixtures.ts';

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

  test("the post event always starts at Comment, whatever the agent's verdict", async () => {
    const user = userEvent.setup();
    const handlers = renderResult(
      makeRun({ status: 'finished', result: makeResult({ verdict: 'requestChanges' }) }),
    );

    await user.click(screen.getByRole('button', { name: 'Post to PR' }));

    const group = screen.getByRole('group', { name: 'Post to Trackunit/manager#101?' });
    expect(within(group).getByRole('radio', { name: 'Comment' })).toHaveProperty('checked', true);
    expect(within(group).getByRole('radio', { name: 'Request changes' })).toHaveProperty(
      'checked',
      false,
    );
    expect(group.textContent).toContain('The agent suggests requesting changes; that is advice.');
    await user.click(within(group).getByRole('button', { name: 'Confirm post' }));
    expect(handlers.onPost).toHaveBeenCalledWith('comment');
  });

  test('the post confirmation counts only findings with a line as inline comments', async () => {
    const user = userEvent.setup();
    renderResult();

    await user.click(screen.getByRole('button', { name: 'Post to PR' }));

    expect(screen.getByRole('group').textContent).toContain(
      'This submits one GitHub review with 3 findings: 2 as inline comments and 1 in the review body.',
    );
  });

  test("says the verdict is advice and PR Quest never approves on the agent's word", () => {
    renderResult(makeRun({ status: 'finished', result: makeResult({ verdict: 'approve' }) }));

    expect(screen.getByRole('dialog').textContent).toContain(
      'The verdict is advice only. PR Quest never turns it into an approval; only you can approve.',
    );
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

  test('names the provider and model that reviewed', () => {
    renderResult(
      makeRun({
        status: 'finished',
        provider: 'claude',
        model: 'claude-opus-5',
        result: makeResult(),
      }),
    );
    expect(screen.getByText('Reviewed by Claude · claude-opus-5')).toBeTruthy();
    cleanup();

    renderResult(makeRun({ status: 'finished', result: makeResult() }));
    expect(screen.getByText('Reviewed by Cursor')).toBeTruthy();
  });

  test('copes with a legacy run that has no provider or model', () => {
    const { provider: _provider, ...legacy } = makeRun({
      status: 'finished',
      result: makeResult(),
    });
    renderResult({ ...legacy, provider: JSON.parse('null') });

    expect(screen.queryByText(/Reviewed/)).toBeNull();
    expect(screen.getByText('Solid change with one risky query.')).toBeTruthy();
  });

  test('lists the files the reviewer never saw', () => {
    renderResult(
      makeRun({
        status: 'finished',
        provider: 'claude',
        result: makeResult({
          omitted: [
            { file: 'yarn.lock', reason: 'lockfile' },
            { file: 'src/huge.generated.ts', reason: 'tooLarge' },
          ],
        }),
      }),
    );

    const section = screen.getByRole('region', { name: /Omitted files/ });
    expect(within(section).getByText('yarn.lock')).toBeTruthy();
    expect(within(section).getByText('(lockfile)')).toBeTruthy();
    expect(within(section).getByText('(too large)')).toBeTruthy();
    expect(within(section).getByText(/never saw these files/)).toBeTruthy();
  });

  test('shows no omitted-files note when nothing was left out', () => {
    renderResult(makeRun({ status: 'finished', result: makeResult({ omitted: [] }) }));
    expect(screen.queryByRole('region', { name: /Omitted files/ })).toBeNull();
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
