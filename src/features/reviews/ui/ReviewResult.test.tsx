// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { FindingDecision, PostReviewEvent, Quest, ReviewRun } from '../../../shared/api.ts';
import { findingDecisionsOf } from '../../../shared/findingDecisions.ts';
import { ReviewResult } from './ReviewResult.tsx';
import { makeQuest, makeResult, makeRun } from '../../../platform/ui/test-utils/fixtures.ts';

interface Handlers {
  onClickClose: () => void;
  onDecide: (findingIndexes: Array<number>, decision: FindingDecision) => Promise<void>;
  onPost: (event: PostReviewEvent, findingIndexes: Array<number>) => Promise<void>;
  onDiscard: () => Promise<void>;
  onClickApprove: (questId: string) => void;
}

/** Saves decisions the way the server does, so the result re-renders with them. */
const Harness = ({
  initialRun,
  quest,
  handlers,
}: {
  initialRun: ReviewRun;
  quest: Quest | undefined;
  handlers: Handlers;
}) => {
  const [run, setRun] = useState(initialRun);
  const onDecide = async (findingIndexes: Array<number>, decision: FindingDecision) => {
    await handlers.onDecide(findingIndexes, decision);
    setRun((current) => {
      const findingDecisions = findingDecisionsOf(current);
      for (const index of findingIndexes) {
        findingDecisions[index] = decision;
      }
      return { ...current, findingDecisions };
    });
  };
  return <ReviewResult quest={quest} run={run} {...handlers} onDecide={onDecide} />;
};

function renderResult(
  run: ReviewRun = makeRun({ status: 'finished', result: makeResult() }),
  /** `null` renders the result for a quest that is no longer in the queue. */
  quest: Quest | null = makeQuest(),
) {
  const handlers = {
    onClickClose: vi.fn(),
    onDecide: vi.fn((_indexes: Array<number>, _decision: FindingDecision) => Promise.resolve()),
    onPost: vi.fn((_event: PostReviewEvent, _indexes: Array<number>) => Promise.resolve()),
    onDiscard: vi.fn(() => Promise.resolve()),
    onClickApprove: vi.fn(),
  };
  render(<Harness handlers={handlers} initialRun={run} quest={quest ?? undefined} />);
  return handlers;
}

/** The fixture's findings by index: 0 is `src/widget.tsx:12`, 1 `src/query.ts:40`, 2 `README.md`. */
function decidedRun(findingDecisions: Array<FindingDecision>): ReviewRun {
  return makeRun({ status: 'finished', result: makeResult(), findingDecisions });
}

const decisionGroup = (location: string) =>
  screen.getByRole('group', { name: `Decision on ${location}` });

const findingItem = (location: string) => {
  const item = screen.getByText(location).closest('li');
  if (!item) {
    throw new Error(`No finding at ${location}`);
  }
  return item;
};

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
    expect(handlers.onPost).toHaveBeenCalledWith('requestChanges', []);
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
    expect(handlers.onPost).toHaveBeenCalledWith('comment', []);
  });

  test('the post confirmation counts only findings with a line as inline comments', async () => {
    const user = userEvent.setup();
    renderResult(decidedRun(['accepted', 'accepted', 'accepted']));

    await user.click(screen.getByRole('button', { name: 'Post to PR' }));

    expect(screen.getByRole('group', { name: /^Post to/ }).textContent).toContain(
      'Posting all 3 findings in one GitHub review: 2 as inline comments and 1 in the review body.',
    );
  });

  describe('deciding on findings', () => {
    test('every finding has Accept and Reject toggles, and starts undecided', () => {
      renderResult();

      for (const location of ['src/query.ts:40', 'src/widget.tsx:12', 'README.md']) {
        const group = decisionGroup(location);
        expect(
          within(group)
            .getAllByRole('button')
            .map((button) => [button.getAttribute('aria-label'), button.ariaPressed]),
        ).toEqual([
          ['Accept', 'false'],
          ['Reject', 'false'],
        ]);
      }
      expect(screen.getByRole('status').textContent).toBe('0 accepted · 0 rejected · 3 undecided');
    });

    test('toggles one finding between accepted, rejected and undecided', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();
      const group = decisionGroup('src/query.ts:40');
      const accept = within(group).getByRole('button', { name: 'Accept' });
      const reject = within(group).getByRole('button', { name: 'Reject' });

      await user.click(accept);
      expect(handlers.onDecide).toHaveBeenLastCalledWith([1], 'accepted');
      expect(accept.ariaPressed).toBe('true');
      expect(reject.ariaPressed).toBe('false');
      expect(screen.getByRole('status').textContent).toBe('1 accepted · 0 rejected · 2 undecided');

      await user.click(reject);
      expect(handlers.onDecide).toHaveBeenLastCalledWith([1], 'rejected');
      expect(accept.ariaPressed).toBe('false');
      expect(reject.ariaPressed).toBe('true');
      expect(findingItem('src/query.ts:40').className).toContain('finding--rejected');

      await user.click(reject);
      expect(handlers.onDecide).toHaveBeenLastCalledWith([1], 'undecided');
      expect(reject.ariaPressed).toBe('false');
      expect(findingItem('src/query.ts:40').className).not.toContain('finding--rejected');
    });

    test('works from the keyboard', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();
      within(decisionGroup('README.md')).getByRole('button', { name: 'Accept' }).focus();

      await user.keyboard(' ');
      expect(handlers.onDecide).toHaveBeenLastCalledWith([2], 'accepted');
      await user.tab();
      await user.keyboard('{Enter}');
      expect(handlers.onDecide).toHaveBeenLastCalledWith([2], 'rejected');
    });

    test('the icon-only toggles have tooltips', () => {
      renderResult();
      const group = decisionGroup('src/query.ts:40');

      const tooltips = within(group)
        .getAllByRole('button')
        .map((button) => document.getElementById(button.getAttribute('aria-describedby') ?? ''));

      expect(tooltips.map((tooltip) => tooltip?.getAttribute('role'))).toEqual([
        'tooltip',
        'tooltip',
      ]);
      expect(tooltips.map((tooltip) => tooltip?.textContent)).toEqual([
        'Accept: post this finding',
        "Reject: don't post this finding",
      ]);
    });

    test('Accept all, Reject all and Reset decide on every finding at once', async () => {
      const user = userEvent.setup();
      const handlers = renderResult(decidedRun(['rejected']));
      const status = screen.getByRole('status');
      expect(status.textContent).toBe('0 accepted · 1 rejected · 2 undecided');

      await user.click(screen.getByRole('button', { name: 'Accept all' }));
      expect(handlers.onDecide).toHaveBeenLastCalledWith([0, 1, 2], 'accepted');
      expect(status.textContent).toBe('3 accepted · 0 rejected · 0 undecided');
      expect(screen.getByRole('button', { name: 'Accept all' })).toHaveProperty('disabled', true);

      await user.click(screen.getByRole('button', { name: 'Reject all' }));
      expect(handlers.onDecide).toHaveBeenLastCalledWith([0, 1, 2], 'rejected');
      expect(status.textContent).toBe('0 accepted · 3 rejected · 0 undecided');

      await user.click(screen.getByRole('button', { name: 'Reset' }));
      expect(handlers.onDecide).toHaveBeenLastCalledWith([0, 1, 2], 'undecided');
      expect(status.textContent).toBe('0 accepted · 0 rejected · 3 undecided');
      expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true);
    });

    test('rejected findings can be hidden and shown again', async () => {
      const user = userEvent.setup();
      renderResult(decidedRun(['accepted', 'rejected', 'undecided']));
      const hide = screen.getByRole('button', { name: 'Hide rejected' });
      expect(hide.ariaPressed).toBe('false');

      await user.click(hide);

      expect(hide.ariaPressed).toBe('true');
      expect(screen.queryByText('src/query.ts:40')).toBeNull();
      expect(screen.queryByRole('region', { name: /Critical/ })).toBeNull();
      expect(screen.getByText('1 rejected finding hidden.')).toBeTruthy();
      expect(screen.getByText('src/widget.tsx:12')).toBeTruthy();

      await user.click(hide);
      expect(screen.getByText('src/query.ts:40')).toBeTruthy();
    });

    test('shows a decision that could not be saved', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();
      handlers.onDecide.mockRejectedValueOnce(new Error('disk full'));

      await user.click(screen.getByRole('button', { name: 'Accept all' }));

      expect((await screen.findByRole('alert')).textContent).toContain('disk full');
      expect(screen.getByRole('status').textContent).toBe('0 accepted · 0 rejected · 3 undecided');
    });

    test('a posted run shows its decisions but no longer changes them', () => {
      renderResult(
        makeRun({
          status: 'finished',
          disposition: 'posted',
          result: makeResult(),
          findingDecisions: ['accepted', 'rejected', 'accepted'],
        }),
      );

      expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
      const toggles = within(decisionGroup('src/query.ts:40')).getAllByRole('button');
      expect(
        toggles.map((button) => [button.ariaPressed, button.hasAttribute('disabled')]),
      ).toEqual([
        ['false', true],
        ['true', true],
      ]);
      expect(screen.getByRole('status').textContent).toBe('2 accepted · 1 rejected · 0 undecided');
    });

    test('a run with no findings offers no decisions', () => {
      renderResult(makeRun({ status: 'finished', result: makeResult({ findings: [] }) }));

      expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('the post confirmation', () => {
    test('posts only the accepted findings and says what stays behind', async () => {
      const user = userEvent.setup();
      const handlers = renderResult(decidedRun(['rejected', 'accepted']));

      await user.click(screen.getByRole('button', { name: 'Post to PR' }));
      const group = screen.getByRole('group', { name: /^Post to/ });

      expect(group.textContent).toContain(
        "Posting 1 of 3 findings in one GitHub review, as an inline comment. 1 rejected and 1 undecided won't be posted.",
      );
      await user.click(within(group).getByRole('button', { name: 'Confirm post' }));
      expect(handlers.onPost).toHaveBeenCalledWith('comment', [1]);
    });

    test('says plainly when only the summary will be posted', async () => {
      const user = userEvent.setup();
      const handlers = renderResult(decidedRun(['rejected', 'rejected']));

      await user.click(screen.getByRole('button', { name: 'Post to PR' }));
      const group = screen.getByRole('group', { name: /^Post to/ });

      expect(group.textContent).toContain(
        "No findings are accepted, so this posts a GitHub review with only the summary. 2 rejected and 1 undecided won't be posted.",
      );
      await user.click(within(group).getByRole('button', { name: 'Confirm post' }));
      expect(handlers.onPost).toHaveBeenCalledWith('comment', []);
    });

    test('follows decisions made while it is open', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();

      await user.click(screen.getByRole('button', { name: 'Post to PR' }));
      await user.click(screen.getByRole('button', { name: 'Accept all' }));

      expect(screen.getByRole('group', { name: /^Post to/ }).textContent).toContain(
        'Posting all 3 findings',
      );
      await user.click(screen.getByRole('button', { name: 'Confirm post' }));
      expect(handlers.onPost).toHaveBeenCalledWith('comment', [0, 1, 2]);
    });
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
