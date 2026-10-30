// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { LoadState } from './gameState.ts';
import { QuestBoard, type QuestBoardProps } from './QuestBoard.tsx';
import { makeQuest } from './test-utils/fixtures.ts';

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
  afterEach(cleanup);

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
