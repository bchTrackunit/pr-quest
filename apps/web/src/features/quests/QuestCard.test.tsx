// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Quest, ReviewRun } from '@pr-quest/contract/api';
import { QuestCard } from './QuestCard.tsx';
import { makeQuest, makeResult, makeRun } from '../../platform/test-utils/fixtures.ts';

const NOW = Date.parse('2026-10-30T10:00:00.000Z');

function renderCard(quest: Quest = makeQuest(), run?: ReviewRun) {
  const handlers = {
    onClickSendAgent: vi.fn(),
    onClickOpenResult: vi.fn(),
    onClickApprove: vi.fn(),
  };
  render(<QuestCard now={NOW} quest={quest} run={run} {...handlers} />);
  return handlers;
}

describe('QuestCard', () => {
  afterEach(cleanup);

  test('shows the quest details', () => {
    renderCard(makeQuest({ needsAttention: true }));
    expect(screen.getByRole('heading', { name: 'Add the fleet health widget' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Trackunit/manager#101' }).getAttribute('href')).toBe(
      'https://github.com/Trackunit/manager/pull/101',
    );
    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('2d')).toBeTruthy();
    expect(screen.getByText('+120')).toBeTruthy();
    expect(screen.getByText('−30')).toBeTruthy();
    expect(screen.getByText(/Needs attention/)).toBeTruthy();
    expect(screen.getByText('Normal')).toBeTruthy();
  });

  test('styles Boss quests as a boss fight', () => {
    renderCard(makeQuest({ difficulty: 'Boss' }));
    expect(screen.getByRole('article').className).toContain('quest--boss');
    expect(screen.getByText('Boss fight')).toBeTruthy();
  });

  test('links to Linear in a new tab, and falls back to GitHub', () => {
    renderCard();
    const linear = screen.getByRole('link', { name: /Open in Linear/ });
    expect(linear.getAttribute('href')).toBe('https://linear.app/trackunit/review/manager-101');
    expect(linear.getAttribute('target')).toBe('_blank');
    cleanup();

    renderCard(makeQuest({ linearUrl: undefined }));
    const github = screen.getByRole('link', { name: /Open on GitHub/ });
    expect(github.getAttribute('href')).toBe('https://github.com/Trackunit/manager/pull/101');
    expect(screen.queryByRole('link', { name: /Open in Linear/ })).toBeNull();
  });

  test('sends the review agent and asks to approve with the quest id', async () => {
    const user = userEvent.setup();
    const handlers = renderCard();
    await user.click(screen.getByRole('button', { name: 'Send review agent' }));
    await user.click(screen.getByRole('button', { name: /Approve/ }));
    expect(handlers.onClickSendAgent).toHaveBeenCalledWith('Trackunit/manager#101');
    expect(handlers.onClickApprove).toHaveBeenCalledWith('Trackunit/manager#101');
  });

  test('shows the agent on its quest while running, without a second send button', () => {
    renderCard(
      makeQuest(),
      makeRun({ status: 'running', startedAt: new Date(Date.now() - 65_000).toISOString() }),
    );
    expect(screen.getByRole('status').textContent).toContain('Agent on quest');
    expect(screen.getByText(/01:0\d/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send review agent' })).toBeNull();
  });

  test('keeps the ticking stopwatch out of the announced status', () => {
    renderCard(
      makeQuest(),
      makeRun({ status: 'running', startedAt: new Date(Date.now() - 65_000).toISOString() }),
    );
    expect(screen.getByRole('status').textContent).not.toMatch(/\d\d:\d\d/);
  });

  test('does not offer to approve a draft PR', () => {
    renderCard(makeQuest({ isDraft: true, status: 'draft' }));
    expect(screen.getByRole('button', { name: /Approve/ })).toHaveProperty('disabled', true);
    expect(screen.getByText("Drafts can't be approved yet.")).toBeTruthy();
  });

  test('offers the loot when the run finished', async () => {
    const user = userEvent.setup();
    const handlers = renderCard(makeQuest(), makeRun({ status: 'finished', result: makeResult() }));
    await user.click(screen.getByRole('button', { name: /Loot ready: 3 findings/ }));
    expect(handlers.onClickOpenResult).toHaveBeenCalledWith('run-1');
  });

  test('offers to open the settings when sending failed for a missing setting', async () => {
    const user = userEvent.setup();
    const onClickOpenSettings = vi.fn();
    render(
      <QuestCard
        actionError={{
          message: 'Cursor reviews need a Cursor API key.',
          settings: { section: 'keys', key: 'cursor' },
        }}
        now={NOW}
        onClickApprove={vi.fn()}
        onClickOpenResult={vi.fn()}
        onClickOpenSettings={onClickOpenSettings}
        onClickSendAgent={vi.fn()}
        quest={makeQuest()}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not send the agent: Cursor reviews need a Cursor');
    await user.click(within(alert).getByRole('button', { name: /Open settings/ }));
    expect(onClickOpenSettings).toHaveBeenCalledWith({ section: 'keys', key: 'cursor' });
  });

  describe('a quest by an author the Cursor agent refuses', () => {
    const outsider = makeQuest({ authorAssociation: 'NONE', isCrossRepository: false });

    test('disables sending the agent on a quest it refuses, and says why', () => {
      render(
        <QuestCard
          now={NOW}
          onClickApprove={vi.fn()}
          onClickOpenResult={vi.fn()}
          onClickSendAgent={vi.fn()}
          quest={outsider}
          reviewProvider="cursor"
        />,
      );

      const send = screen.getByRole('button', { name: 'Send review agent' });
      expect(send).toHaveProperty('disabled', true);
      expect(
        document.getElementById(send.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toContain("outside the repo's org and collaborators (NONE)");
    });

    test('disables Retry on a failed run, and says why', () => {
      render(
        <QuestCard
          now={NOW}
          onClickApprove={vi.fn()}
          onClickOpenResult={vi.fn()}
          onClickSendAgent={vi.fn()}
          quest={outsider}
          reviewProvider="cursor"
          run={makeRun({ provider: 'claude', status: 'error', error: { message: 'Overloaded' } })}
        />,
      );

      const retry = screen.getByRole('button', { name: 'Retry' });
      expect(retry).toHaveProperty('disabled', true);
      expect(
        document.getElementById(retry.getAttribute('aria-describedby') ?? '')?.textContent,
      ).toContain('Review it with Claude instead');
    });

    test('says nothing about the provider while a run is on its way', () => {
      render(
        <QuestCard
          now={NOW}
          onClickApprove={vi.fn()}
          onClickOpenResult={vi.fn()}
          onClickSendAgent={vi.fn()}
          quest={outsider}
          reviewProvider="cursor"
          run={makeRun({ provider: 'claude', status: 'running' })}
        />,
      );

      expect(screen.queryByText(/Review it with Claude instead/)).toBeNull();
    });

    test('offers to switch the review provider from a refused quest', async () => {
      const user = userEvent.setup();
      const onClickOpenSettings = vi.fn();
      render(
        <QuestCard
          now={NOW}
          onClickApprove={vi.fn()}
          onClickOpenResult={vi.fn()}
          onClickOpenSettings={onClickOpenSettings}
          onClickSendAgent={vi.fn()}
          quest={outsider}
          reviewProvider="cursor"
        />,
      );

      await user.click(screen.getByRole('button', { name: /Choose the review provider/ }));
      expect(onClickOpenSettings).toHaveBeenCalledWith({ section: 'provider' });
    });

    test.each([
      {
        provider: 'cursor',
        by: 'Dependabot',
        quest: { author: { name: 'dependabot', githubLogin: 'dependabot[bot]' } },
      },
      { provider: 'claude', by: 'an outside contributor', quest: {} },
    ] as const)('sends the $provider agent on a PR by $by', async ({ provider, quest }) => {
      const user = userEvent.setup();
      const onClickSendAgent = vi.fn();
      render(
        <QuestCard
          now={NOW}
          onClickApprove={vi.fn()}
          onClickOpenResult={vi.fn()}
          onClickSendAgent={onClickSendAgent}
          quest={{ ...outsider, ...quest }}
          reviewProvider={provider}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Send review agent' }));
      expect(onClickSendAgent).toHaveBeenCalledWith('Trackunit/manager#101');
      expect(screen.queryByText(/Review it with Claude instead/)).toBeNull();
    });
  });

  test('shows the error as static text, not an alert, and retries a failed run', async () => {
    const user = userEvent.setup();
    const handlers = renderCard(
      makeQuest(),
      makeRun({ status: 'startupFailed', error: { message: 'CURSOR_API_KEY is missing' } }),
    );
    expect(screen.getByText(/CURSOR_API_KEY is missing/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(handlers.onClickSendAgent).toHaveBeenCalledWith('Trackunit/manager#101');
  });
});
