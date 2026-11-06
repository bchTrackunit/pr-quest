// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { PostReviewEvent, Quest, ReviewRun } from '@pr-quest/contract/api';
import { selectedFindingIndexes } from '@pr-quest/contract/findingSelection';
import { ReviewResult } from './ReviewResult.tsx';
import { makeQuest, makeResult, makeRun } from '../../platform/test-utils/fixtures.ts';

interface Handlers {
  onClickClose: () => void;
  onSelect: (findingIndexes: Array<number>, selected: boolean) => Promise<void>;
  onPost: (event: PostReviewEvent, findingIndexes: Array<number>) => Promise<void>;
  onDiscard: () => Promise<void>;
  onClickApprove: (questId: string) => void;
}

/** Saves selections the way the server does, so the result re-renders with them. */
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
  const onSelect = async (findingIndexes: Array<number>, selected: boolean) => {
    await handlers.onSelect(findingIndexes, selected);
    setRun((current) => {
      const selection = new Set(selectedFindingIndexes(current));
      for (const index of findingIndexes) {
        if (selected) {
          selection.add(index);
        } else {
          selection.delete(index);
        }
      }
      return { ...current, selectedFindings: [...selection].sort((a, b) => a - b) };
    });
  };
  return <ReviewResult quest={quest} run={run} {...handlers} onSelect={onSelect} />;
};

function renderResult(
  run: ReviewRun = makeRun({ status: 'finished', result: makeResult() }),
  /** `null` renders the result for a quest that is no longer in the queue. */
  quest: Quest | null = makeQuest(),
) {
  const handlers = {
    onClickClose: vi.fn(),
    onSelect: vi.fn((_indexes: Array<number>, _selected: boolean) => Promise.resolve()),
    onPost: vi.fn((_event: PostReviewEvent, _indexes: Array<number>) => Promise.resolve()),
    onDiscard: vi.fn(() => Promise.resolve()),
    onClickApprove: vi.fn(),
  };
  render(<Harness handlers={handlers} initialRun={run} quest={quest ?? undefined} />);
  return handlers;
}

/** The fixture's findings by index: 0 is `src/widget.tsx:12`, 1 `src/query.ts:40`, 2 `README.md`. */
function selectedRun(selectedFindings: Array<number>): ReviewRun {
  return makeRun({ status: 'finished', result: makeResult(), selectedFindings });
}

const selectToggle = (location: string) =>
  screen.getByRole('button', { name: `Select ${location}` });

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

  test('the post confirmation puts findings without a line on their file, never in the body', async () => {
    const user = userEvent.setup();
    renderResult(selectedRun([0, 1, 2]));

    await user.click(screen.getByRole('button', { name: 'Post to PR' }));

    const text = screen.getByRole('group', { name: /^Post to/ }).textContent;
    expect(text).toContain(
      'Posting all 3 findings in one GitHub review: 2 as inline comments and 1 as a comment on its file.',
    );
    expect(text).toContain('If GitHub rejects a line, that finding goes on its file instead.');
    expect(text).not.toContain('review body');
  });

  test('shows a suggested change and counts it in the post confirmation', async () => {
    const user = userEvent.setup();
    const result = makeResult({
      findings: [
        {
          file: 'src/query.ts',
          line: 42,
          startLine: 40,
          severity: 'critical',
          body: 'This query is unbounded.',
          suggestion: 'query.limit(100);',
        },
      ],
    });
    renderResult(makeRun({ status: 'finished', result, selectedFindings: [0] }));

    expect(screen.getByText('src/query.ts:40-42')).toBeTruthy();
    expect(screen.getByText('query.limit(100);')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Post to PR' }));
    expect(screen.getByRole('group', { name: /^Post to/ }).textContent).toContain(
      'Posting the only finding in one GitHub review, as an inline comment. One comes with a suggested change.',
    );
  });

  describe('selecting findings', () => {
    test('every finding has a select toggle, and none starts selected', () => {
      renderResult();

      for (const location of ['src/query.ts:40', 'src/widget.tsx:12', 'README.md']) {
        expect(selectToggle(location).ariaPressed).toBe('false');
      }
      expect(screen.queryByRole('button', { name: /^(Accept|Reject)/ })).toBeNull();
      expect(screen.getByRole('status').textContent).toBe('0 of 3 selected');
    });

    test('toggles one finding between selected and not', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();
      const toggle = selectToggle('src/query.ts:40');

      await user.click(toggle);
      expect(handlers.onSelect).toHaveBeenLastCalledWith([1], true);
      expect(toggle.ariaPressed).toBe('true');
      expect(findingItem('src/query.ts:40').className).toContain('finding--selected');
      expect(screen.getByRole('status').textContent).toBe('1 of 3 selected');

      await user.click(toggle);
      expect(handlers.onSelect).toHaveBeenLastCalledWith([1], false);
      expect(toggle.ariaPressed).toBe('false');
      expect(findingItem('src/query.ts:40').className).not.toContain('finding--selected');
    });

    test('works from the keyboard', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();
      selectToggle('README.md').focus();

      await user.keyboard(' ');
      expect(handlers.onSelect).toHaveBeenLastCalledWith([2], true);
      await user.keyboard('{Enter}');
      expect(handlers.onSelect).toHaveBeenLastCalledWith([2], false);
    });

    test('the icon-only toggle has a tooltip that follows its state', async () => {
      const user = userEvent.setup();
      renderResult();
      const toggle = selectToggle('src/query.ts:40');
      const tooltip = () => document.getElementById(toggle.getAttribute('aria-describedby') ?? '');

      expect(tooltip()?.getAttribute('role')).toBe('tooltip');
      expect(tooltip()?.textContent).toBe('Select to post this finding');

      await user.click(toggle);
      expect(tooltip()?.textContent).toBe('Selected: this finding will be posted');
    });

    test('Select all and Clear change every finding at once', async () => {
      const user = userEvent.setup();
      const handlers = renderResult(selectedRun([1]));
      const status = screen.getByRole('status');
      expect(status.textContent).toBe('1 of 3 selected');

      await user.click(screen.getByRole('button', { name: 'Select all' }));
      expect(handlers.onSelect).toHaveBeenLastCalledWith([0, 1, 2], true);
      expect(status.textContent).toBe('3 of 3 selected');
      expect(screen.getByRole('button', { name: 'Select all' })).toHaveProperty('disabled', true);

      await user.click(screen.getByRole('button', { name: 'Clear' }));
      expect(handlers.onSelect).toHaveBeenLastCalledWith([0, 1, 2], false);
      expect(status.textContent).toBe('0 of 3 selected');
      expect(screen.getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', true);
    });

    test('shows a selection that could not be saved', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();
      handlers.onSelect.mockRejectedValueOnce(new Error('disk full'));

      await user.click(screen.getByRole('button', { name: 'Select all' }));

      expect((await screen.findByRole('alert')).textContent).toContain('disk full');
      expect(screen.getByRole('status').textContent).toBe('0 of 3 selected');
    });

    test('a posted run shows its selection but no longer changes it', () => {
      renderResult(
        makeRun({
          status: 'finished',
          disposition: 'posted',
          result: makeResult(),
          selectedFindings: [0, 2],
        }),
      );

      expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
      expect(
        ['src/widget.tsx:12', 'src/query.ts:40'].map((location) => {
          const toggle = selectToggle(location);
          return [toggle.ariaPressed, toggle.hasAttribute('disabled')];
        }),
      ).toEqual([
        ['true', true],
        ['false', true],
      ]);
      expect(screen.getByRole('status').textContent).toBe('2 of 3 selected');
    });

    test('a run with no findings offers no selection', () => {
      renderResult(makeRun({ status: 'finished', result: makeResult({ findings: [] }) }));

      expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('the post confirmation', () => {
    test('posts only the selected findings and says what stays behind', async () => {
      const user = userEvent.setup();
      const handlers = renderResult(selectedRun([1]));

      await user.click(screen.getByRole('button', { name: 'Post to PR' }));
      const group = screen.getByRole('group', { name: /^Post to/ });

      expect(group.textContent).toContain(
        "Posting 1 of 3 findings in one GitHub review, as an inline comment. The other 2 won't be posted.",
      );
      await user.click(within(group).getByRole('button', { name: 'Confirm post' }));
      expect(handlers.onPost).toHaveBeenCalledWith('comment', [1]);
    });

    test('says plainly when only the summary will be posted', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();

      await user.click(screen.getByRole('button', { name: 'Post to PR' }));
      const group = screen.getByRole('group', { name: /^Post to/ });

      expect(group.textContent).toContain(
        'No findings are selected, so this posts a GitHub review with only the summary.',
      );
      await user.click(within(group).getByRole('button', { name: 'Confirm post' }));
      expect(handlers.onPost).toHaveBeenCalledWith('comment', []);
    });

    test('follows selections made while it is open', async () => {
      const user = userEvent.setup();
      const handlers = renderResult();

      await user.click(screen.getByRole('button', { name: 'Post to PR' }));
      await user.click(screen.getByRole('button', { name: 'Select all' }));

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

  test('discards, approves and links to the Linear guide and GitHub', async () => {
    const user = userEvent.setup();
    const handlers = renderResult();
    expect(screen.getByRole('link', { name: /Open in Linear/ }).getAttribute('href')).toBe(
      'https://linear.app/trackunit/review/manager-101/review',
    );
    expect(screen.getByRole('link', { name: /Open on GitHub/ }).getAttribute('href')).toBe(
      'https://github.com/Trackunit/manager/pull/101',
    );
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(handlers.onClickApprove).toHaveBeenCalledWith('Trackunit/manager#101');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(handlers.onDiscard).toHaveBeenCalled();
  });

  test('a self-review is read-only: no selection, Post, Approve or Request changes, only Discard', async () => {
    const user = userEvent.setup();
    const handlers = renderResult(
      makeRun({ status: 'finished', result: makeResult(), ownPr: true }),
      null,
    );

    const dialog = screen.getByRole('dialog', { name: 'Self-review of Trackunit/manager#101' });
    expect(dialog.textContent).toContain('Nothing here is posted to GitHub, and it earns no XP.');
    expect(within(dialog).getByText('src/query.ts:40')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Select / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Post to PR' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Request changes/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(handlers.onDiscard).toHaveBeenCalled();
    expect(handlers.onPost).not.toHaveBeenCalled();
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
