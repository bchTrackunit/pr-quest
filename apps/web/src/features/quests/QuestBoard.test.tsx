// @vitest-environment jsdom
/* oxlint-disable no-restricted-globals -- tests reset and seed the jsdom storage the board persists to */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { formatClock } from '../../platform/format.ts';
import type { LoadState } from '../game/index.ts';
import { QuestBoard, type QuestBoardProps } from './QuestBoard.tsx';
import { makeQuest, makeRun } from '../../platform/test-utils/fixtures.ts';

function renderBoard(overrides: Partial<QuestBoardProps> = {}) {
  const props: QuestBoardProps = {
    quests: [],
    runs: {},
    loadState: 'ready' satisfies LoadState,
    fetchedAt: '2026-10-30T10:00:00.000Z',
    questActions: {},
    questActionErrors: {},
    onClickRefresh: vi.fn(),
    onClickSendAgent: vi.fn(),
    onClickOpenResult: vi.fn(),
    onClickApprove: vi.fn(),
    ...overrides,
  };
  render(<QuestBoard {...props} />);
  return props;
}

describe('QuestBoard', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test('shows a loading state on the first load', () => {
    renderBoard({ loadState: 'loading', fetchedAt: undefined });
    expect(screen.getByRole('status').textContent).toContain('Unrolling the quest map');
  });

  test('shows the error with a retry', async () => {
    const user = userEvent.setup();
    const props = renderBoard({
      loadState: 'error',
      error: 'gh is not logged in',
      fetchedAt: undefined,
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('gh is not logged in');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(props.onClickRefresh).toHaveBeenCalled();
  });

  test('celebrates Inbox Zero when there are no quests', () => {
    renderBoard();
    expect(screen.getByText('Inbox Zero!')).toBeTruthy();
  });

  test('groups direct and team requests and filters between them', async () => {
    const user = userEvent.setup();
    renderBoard({
      quests: [
        makeQuest({
          number: 1,
          title: 'Team quest',
          requestKind: 'team',
          requestedTeams: ['team-gluon'],
        }),
        makeQuest({ number: 2, title: 'Direct quest' }),
      ],
    });

    const direct = screen.getByRole('region', { name: /Direct requests/ });
    const team = screen.getByRole('region', { name: /Team requests/ });
    expect(within(direct).getByRole('heading', { name: 'Direct quest' })).toBeTruthy();
    expect(within(team).getByRole('heading', { name: 'Team quest' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /^Team/ }));
    expect(screen.queryByRole('heading', { name: 'Direct quest' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Team quest' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Team/ }).getAttribute('aria-pressed')).toBe('true');
  });

  test('refreshes on demand and keeps quests visible when a refresh fails', async () => {
    const user = userEvent.setup();
    const props = renderBoard({ quests: [makeQuest()], loadState: 'error', error: 'timeout' });
    expect(screen.getByRole('alert').textContent).toContain('Refresh failed: timeout');
    expect(screen.getByRole('heading', { name: 'Add the fleet health widget' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(props.onClickRefresh).toHaveBeenCalled();
  });
});

const BOARD_QUESTS = [
  makeQuest({
    number: 1,
    title: 'Tiny typo fix',
    difficulty: 'Trivial',
    diffStats: { additions: 2, deletions: 1, fileCount: 1 },
  }),
  makeQuest({
    number: 2,
    title: 'Rewrite the map engine',
    difficulty: 'Boss',
    diffStats: { additions: 4000, deletions: 900, fileCount: 80 },
    approvedByOthers: true,
    approvalCount: 1,
  }),
  makeQuest({
    number: 3,
    title: 'Draft: new alerts page',
    difficulty: 'Normal',
    isDraft: true,
    status: 'draft',
    requestKind: 'team',
    requestedTeams: ['team-gluon'],
    diffStats: { additions: 200, deletions: 20, fileCount: 6 },
  }),
];

const titles = (): Array<string> =>
  screen
    .getAllByRole('heading', { level: 3 })
    .flatMap((heading) => (heading.closest('article') ? [heading.textContent] : []));

const showing = (): string =>
  screen.getByText(/^Showing/, { selector: '.filters__count' }).textContent;

type User = ReturnType<typeof userEvent.setup>;

/** Opens the Filters panel and returns it. */
async function openFilters(user: User) {
  await user.click(screen.getByRole('button', { name: /^Filters/ }));
  return screen.getByRole('group', { name: 'Filters' });
}

/** Opens the presets dropdown and returns it. */
async function openPresets(user: User) {
  await user.click(screen.getByRole('button', { name: /^Presets/ }));
  return screen.getByRole('dialog', { name: 'Presets' });
}

const sortSelect = (): HTMLElement => screen.getByRole('combobox', { name: 'Sort' });

describe('QuestBoard filters and sorting', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  test('keeps search, sort, presets and the Filters toggle on one toolbar, filters collapsed', () => {
    renderBoard({ quests: BOARD_QUESTS });

    expect(screen.getByRole('searchbox', { name: 'Search quests' })).toBeTruthy();
    expect(sortSelect()).toHaveProperty('value', 'smart');
    expect(screen.getByRole('button', { name: 'Presets' })).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /^Filters/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Difficulty' })).toBeNull();
  });

  test('searches after a pause in typing, and Escape clears the search', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    const search = screen.getByRole('searchbox', { name: /Search quests/ });

    await user.type(search, '#2');
    expect(showing()).toBe('Showing 3 of 3 quests');
    await waitFor(() => expect(showing()).toBe('Showing 1 of 3 quests'));
    expect(titles()).toEqual(['Rewrite the map engine']);
    expect(screen.getByRole('button', { name: 'Remove filter Search: “#2”' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(showing()).toBe('Showing 3 of 3 quests');
    expect(search).toHaveProperty('value', '');
  });

  test('Enter applies the search right away and / focuses the search box', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });

    await user.keyboard('/');
    const search = screen.getByRole('searchbox', { name: /Search quests/ });
    expect(document.activeElement).toBe(search);

    await user.keyboard('manager#3{Enter}');
    expect(showing()).toBe('Showing 1 of 3 quests');
  });

  test('the Filters toggle opens the panel, counts active filters and closes on Escape', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    const toggle = screen.getByRole('button', { name: /^Filters/ });

    const panel = await openFilters(user);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    await user.click(within(panel).getByRole('button', { name: 'Boss' }));
    await user.click(within(panel).getByRole('button', { name: 'Drafts' }));
    expect(toggle.textContent).toContain('2');
    expect(screen.getByRole('button', { name: 'Filters (2 active)' })).toBe(toggle);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Filters' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: 'Remove filter Tier: Boss' })).toBeTruthy();
  });

  test('search and request kind are not counted on the Filters toggle', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await user.click(screen.getByRole('button', { name: /^Team/ }));
    await user.type(screen.getByRole('searchbox', { name: 'Search quests' }), 'alerts{Enter}');

    expect(screen.getByRole('button', { name: /^Filters/ }).textContent).not.toMatch(/\d/);
    expect(screen.getByRole('button', { name: 'Remove filter Requests: Team' })).toBeTruthy();
  });

  test('filters by tier with pressed toggles and removable chips', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await openFilters(user);
    const difficulty = screen.getByRole('group', { name: 'Difficulty' });

    await user.click(within(difficulty).getByRole('button', { name: 'Trivial' }));
    await user.click(within(difficulty).getByRole('button', { name: 'Normal' }));

    expect(
      within(difficulty).getByRole('button', { name: 'Trivial' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(titles()).toEqual(['Tiny typo fix', 'Draft: new alerts page']);
    expect(showing()).toBe('Showing 2 of 3 quests');

    await user.click(screen.getByRole('button', { name: 'Remove filter Tier: Trivial' }));
    expect(titles()).toEqual(['Draft: new alerts page']);
  });

  test('hides drafts and PRs others approved', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await openFilters(user);
    const hide = screen.getByRole('group', { name: 'Hide' });

    await user.click(within(hide).getByRole('button', { name: 'Drafts' }));
    await user.click(within(hide).getByRole('button', { name: 'Approved by others' }));

    expect(within(hide).getByRole('button', { name: 'Drafts' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(titles()).toEqual(['Tiny typo fix']);
  });

  test('filters by agent state', async () => {
    const user = userEvent.setup();
    renderBoard({
      quests: BOARD_QUESTS,
      runs: {
        'run-1': makeRun({ id: 'run-1', questId: 'Trackunit/manager#2', status: 'finished' }),
      },
    });
    await openFilters(user);

    await user.click(
      within(screen.getByRole('group', { name: 'Agent' })).getByRole('button', {
        name: 'Loot ready',
      }),
    );

    expect(titles()).toEqual(['Rewrite the map engine']);
  });

  test('shows a clearable empty state when filters hide everything, not Inbox Zero', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });

    await user.click(screen.getByRole('button', { name: /^Team/ }));
    await openFilters(user);
    await user.click(screen.getByRole('button', { name: 'Drafts' }));

    expect(screen.getByText('No quests match')).toBeTruthy();
    expect(screen.queryByText('Inbox Zero!')).toBeNull();
    expect(showing()).toBe('Showing 0 of 3 quests');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(showing()).toBe('Showing 3 of 3 quests');
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  test('Clear all removes every chip', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await openFilters(user);
    await user.click(screen.getByRole('button', { name: 'Boss' }));
    await user.click(screen.getByRole('button', { name: 'Drafts' }));

    await user.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(screen.queryByRole('list', { name: 'Active filters' })).toBeNull();
    expect(showing()).toBe('Showing 3 of 3 quests');
    expect(screen.getByRole('button', { name: /^Filters/ }).textContent).not.toMatch(/\d/);
  });

  test('sorts by size in both directions inside the Direct and Team groups', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    const direct = (): Array<string> =>
      within(screen.getByRole('region', { name: /Direct requests/ }))
        .getAllByRole('heading', { level: 3 })
        .slice(1)
        .map((heading) => heading.textContent);

    expect(
      within(sortSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Smart', 'Smallest first', 'Largest first', 'Newest first', 'Oldest first']);

    await user.selectOptions(sortSelect(), 'Smallest first');
    expect(direct()).toEqual(['Tiny typo fix', 'Rewrite the map engine']);

    await user.selectOptions(sortSelect(), 'Largest first');
    expect(direct()).toEqual(['Rewrite the map engine', 'Tiny typo fix']);
    expect(screen.getByRole('region', { name: /Team requests/ })).toBeTruthy();

    await user.selectOptions(sortSelect(), 'Smart');
    expect(sortSelect()).toHaveProperty('value', 'smart');
  });

  test('sorts by when the PR was created in both directions', async () => {
    const user = userEvent.setup();
    renderBoard({
      quests: [
        makeQuest({ number: 1, title: 'Older PR', openedAt: '2026-10-01T00:00:00Z' }),
        makeQuest({ number: 2, title: 'Newer PR', openedAt: '2026-10-05T00:00:00Z' }),
      ],
    });

    await user.selectOptions(sortSelect(), 'Newest first');
    expect(titles()).toEqual(['Newer PR', 'Older PR']);
    expect(sortSelect()).toHaveProperty('value', 'created-desc');

    await user.selectOptions(sortSelect(), 'Oldest first');
    expect(titles()).toEqual(['Older PR', 'Newer PR']);
  });

  test('moves between toggles with the arrow keys', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await openFilters(user);
    const difficulty = screen.getByRole('group', { name: 'Difficulty' });
    within(difficulty).getByRole('button', { name: 'Trivial' }).focus();

    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toBe('Normal');
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toBe('Boss');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toBe('Trivial');
  });

  test('applies the built-in Quick wins and Boss rush presets from the dropdown', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    const presetsButton = screen.getByRole('button', { name: 'Presets' });
    expect(presetsButton.getAttribute('aria-expanded')).toBe('false');

    let menu = await openPresets(user);
    expect(within(menu).queryByRole('button', { name: /Delete preset Quick wins/ })).toBeNull();
    await user.click(within(menu).getByRole('button', { name: 'Quick wins' }));
    expect(screen.queryByRole('dialog', { name: 'Presets' })).toBeNull();
    expect(document.activeElement).toBe(presetsButton);
    expect(titles()).toEqual(['Tiny typo fix']);
    expect(presetsButton.textContent).toContain('Quick wins');
    expect(screen.getByRole('button', { name: 'Presets: Quick wins' })).toBe(presetsButton);

    menu = await openPresets(user);
    expect(
      within(menu).getByRole('button', { name: 'Quick wins' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await user.click(within(menu).getByRole('button', { name: 'Boss rush' }));
    expect(titles()).toEqual(['Rewrite the map engine']);
    expect(sortSelect()).toHaveProperty('value', 'size-desc');
  });

  test('Escape closes the presets dropdown, and closes the save form first', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    const presetsButton = screen.getByRole('button', { name: 'Presets' });

    await openPresets(user);
    await user.click(screen.getByRole('button', { name: /Save current/ }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Preset name' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Preset name' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Presets' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Presets' })).toBeNull();
    expect(document.activeElement).toBe(presetsButton);
  });

  test('saves, applies and deletes a custom preset', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await user.click(screen.getByRole('button', { name: /^Team/ }));

    await openPresets(user);
    await user.click(screen.getByRole('button', { name: /Save current/ }));
    const name = screen.getByRole('textbox', { name: 'Preset name' });
    expect(document.activeElement).toBe(name);
    await user.type(name, 'Quick wins{Enter}');
    expect(screen.getByRole('alert').textContent).toContain('built-in');

    await user.clear(name);
    await user.type(name, 'Guild duty{Enter}');
    expect(screen.queryByRole('textbox', { name: 'Preset name' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Save current/ }));

    await user.click(screen.getByRole('button', { name: /^All/ }));
    await openPresets(user);
    await user.click(screen.getByRole('button', { name: 'Guild duty' }));
    expect(titles()).toEqual(['Draft: new alerts page']);

    await openPresets(user);
    const remove = screen.getByRole('button', { name: 'Delete preset Guild duty' });
    await user.hover(remove);
    expect(screen.getByRole('tooltip').id).toBe(remove.getAttribute('aria-describedby'));
    expect(screen.getByRole('tooltip').textContent).toBe('Delete preset');
    await user.click(remove);
    expect(screen.queryByRole('button', { name: 'Guild duty' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Save current/ }));
  });

  test('remembers the filters, sort and presets across reloads', async () => {
    const user = userEvent.setup();
    renderBoard({ quests: BOARD_QUESTS });
    await user.selectOptions(sortSelect(), 'Smallest first');
    await openFilters(user);
    await user.click(screen.getByRole('button', { name: 'Drafts' }));
    await openPresets(user);
    await user.click(screen.getByRole('button', { name: /Save current/ }));
    await user.type(screen.getByRole('textbox', { name: 'Preset name' }), 'Mine{Enter}');

    cleanup();
    renderBoard({ quests: BOARD_QUESTS });

    expect(sortSelect()).toHaveProperty('value', 'size-asc');
    expect(screen.getByRole('button', { name: 'Filters (1 active)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Presets: Mine' })).toBeTruthy();
    await openFilters(user);
    expect(screen.getByRole('button', { name: 'Drafts' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('ignores a corrupt saved view', () => {
    localStorage.setItem('pr-quest:board-view:v1', '{"filters":{"kind":42}');
    renderBoard({ quests: BOARD_QUESTS });

    expect(showing()).toBe('Showing 3 of 3 quests');
  });
});

describe('QuestBoard rate limits', () => {
  afterEach(cleanup);

  test('keeps the quests, explains the limit calmly and counts down instead of refreshing', () => {
    const fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const limitedUntil = new Date(Date.now() + 42_500).toISOString();
    const props = renderBoard({
      quests: [makeQuest()],
      fetchedAt,
      stale: true,
      rateLimit: { kind: 'primary', limitedUntil },
    });

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain(
      `GitHub rate limit reached, showing results from ${formatClock(fetchedAt)}, retrying at ${formatClock(limitedUntil)}.`,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    const refresh = screen.getByRole('button', { name: /Retry in 00:4\d/ });
    expect(refresh).toHaveProperty('disabled', true);
    expect(props.onClickRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Add the fleet health widget' })).toBeTruthy();
  });

  test('words a secondary limit as GitHub asking to slow down', () => {
    renderBoard({
      quests: [makeQuest()],
      rateLimit: { kind: 'secondary', limitedUntil: new Date(Date.now() + 60_000).toISOString() },
    });

    expect(screen.getByRole('status').textContent).toContain('GitHub asked PR Quest to slow down');
  });

  test('re-enables Refresh once the limit has passed', () => {
    renderBoard({
      quests: [makeQuest()],
      rateLimit: { kind: 'primary', limitedUntil: new Date(Date.now() - 1000).toISOString() },
    });

    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: /Refresh/ })).toHaveProperty('disabled', false);
  });
});
