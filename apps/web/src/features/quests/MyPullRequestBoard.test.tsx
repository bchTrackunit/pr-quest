// @vitest-environment jsdom
/* oxlint-disable no-restricted-globals -- tests reset and read the jsdom storage the tab persists to */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { LoadState } from '../game/index.ts';
import { makeMyPullRequest, makeResult, makeRun } from '../../platform/test-utils/fixtures.ts';
import { VIEW_STORAGE_KEY } from './boardViewStorage.ts';
import { MY_PRS_VIEW_STORAGE_KEY } from './myPrFilters.ts';
import { MyPullRequestBoard, type MyPullRequestBoardProps } from './MyPullRequestBoard.tsx';

function renderBoard(overrides: Partial<MyPullRequestBoardProps> = {}) {
  const props: MyPullRequestBoardProps = {
    pullRequests: [],
    runs: {},
    loadState: 'ready' satisfies LoadState,
    fetchedAt: '2026-10-30T10:00:00.000Z',
    questActions: {},
    questActionErrors: {},
    onClickRefresh: vi.fn(),
    onClickSelfReview: vi.fn(),
    onClickOpenResult: vi.fn(),
    ...overrides,
  };
  render(<MyPullRequestBoard {...props} />);
  return props;
}

const card = (title: string): HTMLElement => screen.getByRole('article', { name: title });

const titles = (): Array<string> =>
  screen.getAllByRole('article').map((article) => article.querySelector('h3')?.textContent ?? '');

const BOARD = [
  makeMyPullRequest({
    number: 1,
    title: 'Waiting quietly',
    openedAt: '2026-10-01T10:00:00.000Z',
  }),
  makeMyPullRequest({
    number: 2,
    title: 'Needs fixes',
    reviewState: 'changesRequested',
    ciState: 'failing',
    mergeState: 'conflicting',
    unresolvedThreads: 1,
    needsMyAction: true,
    openedAt: '2026-10-20T10:00:00.000Z',
  }),
  makeMyPullRequest({
    number: 3,
    title: 'Ready to merge',
    reviewState: 'approved',
    openedAt: '2026-09-01T10:00:00.000Z',
  }),
  makeMyPullRequest({
    number: 4,
    title: 'Sketch',
    isDraft: true,
    ciState: 'none',
    mergeState: 'behind',
    difficulty: 'Boss',
    openedAt: '2026-10-25T10:00:00.000Z',
  }),
];

describe('MyPullRequestBoard', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test('shows a loading state on the first load', () => {
    renderBoard({ loadState: 'loading', fetchedAt: undefined });
    expect(screen.getByRole('status').textContent).toContain('Gathering your PRs');
  });

  test('shows the error with a retry', async () => {
    const user = userEvent.setup();
    const props = renderBoard({
      loadState: 'error',
      error: 'GitHub is down',
      fetchedAt: undefined,
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('GitHub is down');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(props.onClickRefresh).toHaveBeenCalled();
  });

  test('says so when I have no open PRs', () => {
    renderBoard();
    expect(screen.getByText('No open PRs')).toBeTruthy();
  });

  test('each card shows review, CI, merge and thread state, tier, age and draft', () => {
    renderBoard({ pullRequests: BOARD });

    const fixes = within(card('Needs fixes'));
    expect(fixes.getByText('Needs my action')).toBeTruthy();
    expect(fixes.getByText('Changes requested')).toBeTruthy();
    expect(fixes.getByText('CI failing')).toBeTruthy();
    expect(fixes.getByText('Merge conflicts')).toBeTruthy();
    expect(fixes.getByText('1 unresolved thread')).toBeTruthy();
    expect(fixes.getByText('Trivial')).toBeTruthy();
    expect(fixes.getByText('Trackunit/manager#2', { exact: false })).toBeTruthy();

    const sketch = within(card('Sketch'));
    expect(sketch.getByText('Draft')).toBeTruthy();
    expect(sketch.getByText('No checks')).toBeTruthy();
    expect(sketch.getByText('Out of date')).toBeTruthy();
    expect(sketch.getByText('Boss fight')).toBeTruthy();
    expect(sketch.queryByText('Needs my action')).toBeNull();

    const ready = within(card('Ready to merge'));
    expect(ready.getByText('Approved')).toBeTruthy();
    expect(ready.getByText('CI passing')).toBeTruthy();
    expect(ready.queryByText(/unresolved/)).toBeNull();
    expect(ready.queryByText(/Merge|Out of date/)).toBeNull();
    expect(ready.getByRole('link', { name: /Open on GitHub/ }).getAttribute('href')).toBe(
      'https://github.com/Trackunit/manager/pull/3',
    );
  });

  test('marks a thread count GitHub cut short with a plus', () => {
    renderBoard({
      pullRequests: [makeMyPullRequest({ unresolvedThreads: 100, moreThreads: true })],
    });
    expect(screen.getByText('100+ unresolved threads')).toBeTruthy();
  });

  test('puts PRs that need my action first, then those waiting on others, oldest first', () => {
    renderBoard({ pullRequests: BOARD });
    expect(titles()).toEqual(['Needs fixes', 'Waiting quietly', 'Sketch', 'Ready to merge']);
  });

  test('filters by needs my action and drafts, remembered apart from the review board', async () => {
    const user = userEvent.setup();
    renderBoard({ pullRequests: BOARD });

    await user.click(screen.getByRole('button', { name: /Hide drafts/ }));
    expect(titles()).not.toContain('Sketch');
    await user.click(screen.getByRole('button', { name: /Only needs my action/ }));
    expect(titles()).toEqual(['Needs fixes']);
    expect(screen.getByText(/Showing/).textContent).toBe('Showing 1 of 4 PRs');

    expect(localStorage.getItem(VIEW_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(MY_PRS_VIEW_STORAGE_KEY) ?? '{}')).toMatchObject({
      filters: { hideDrafts: true, needsMyAction: true },
    });

    cleanup();
    renderBoard({ pullRequests: BOARD });
    expect(titles()).toEqual(['Needs fixes']);

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(titles()).toHaveLength(4);
  });

  test('searches and filters by difficulty, and offers a way out when nothing matches', async () => {
    const user = userEvent.setup();
    renderBoard({ pullRequests: BOARD });

    await user.click(screen.getByRole('button', { name: 'Boss' }));
    expect(titles()).toEqual(['Sketch']);

    await user.type(screen.getByRole('searchbox', { name: 'Search your PRs' }), 'merge{Enter}');
    expect(screen.getByText('No PRs match')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(titles()).toHaveLength(4);
  });

  test('/ jumps to the search', async () => {
    const user = userEvent.setup();
    renderBoard({ pullRequests: BOARD });
    await user.keyboard('/');
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Search your PRs' }));
  });

  test('Summon agent starts a self-review, and the card follows the run', async () => {
    const user = userEvent.setup();
    const pr = makeMyPullRequest();
    const props = renderBoard({ pullRequests: [pr] });

    await user.click(screen.getByRole('button', { name: 'Summon agent' }));
    expect(props.onClickSelfReview).toHaveBeenCalledWith(pr.id);

    cleanup();
    const run = makeRun({
      id: 'self-1',
      questId: pr.id,
      ownPr: true,
      status: 'finished',
      result: makeResult(),
    });
    const after = renderBoard({ pullRequests: [pr], runs: { [run.id]: run } });
    expect(screen.queryByRole('button', { name: 'Summon agent' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Loot ready: 3 findings/ }));
    expect(after.onClickOpenResult).toHaveBeenCalledWith('self-1');
  });

  test('offers Summon agent again once the self-review was discarded', () => {
    const pr = makeMyPullRequest();
    const run = makeRun({
      questId: pr.id,
      ownPr: true,
      status: 'finished',
      disposition: 'discarded',
      result: makeResult(),
    });
    renderBoard({ pullRequests: [pr], runs: { [run.id]: run } });
    expect(screen.getByRole('button', { name: 'Summon agent' })).toBeTruthy();
  });

  test('applies the Cursor safety rules to my own PRs too', () => {
    renderBoard({
      pullRequests: [makeMyPullRequest({ isCrossRepository: true })],
      reviewProvider: 'cursor',
    });
    const button = screen.getByRole('button', { name: 'Summon agent' });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByText(/comes from a fork/)).toBeTruthy();
  });

  test('Refresh calls through, and waits out a rate limit', async () => {
    const user = userEvent.setup();
    const props = renderBoard({ pullRequests: BOARD });
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(props.onClickRefresh).toHaveBeenCalledTimes(1);

    cleanup();
    renderBoard({
      pullRequests: BOARD,
      stale: true,
      rateLimit: { kind: 'primary', limitedUntil: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(screen.getByRole('button', { name: /Retry in/ })).toHaveProperty('disabled', true);
    expect(screen.getByText(/GitHub rate limit reached, showing results from/)).toBeTruthy();
  });
});
