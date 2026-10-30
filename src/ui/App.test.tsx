// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ServerEvent } from '../shared/api.ts';
import { ApiRequestError } from './apiClient.ts';
import * as apiClient from './apiClient.ts';
import { App } from './App.tsx';
import {
  makeAchievements,
  makePlayer,
  makeQuest,
  makeResult,
  makeRun,
} from './test-utils/fixtures.ts';
import { MockEventSource } from './test-utils/MockEventSource.ts';

vi.mock('./apiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apiClient.ts')>();
  return {
    ...actual,
    fetchQuests: vi.fn(),
    fetchRuns: vi.fn(),
    fetchPlayer: vi.fn(),
    fetchAchievements: vi.fn(),
    startReview: vi.fn(),
    approveQuest: vi.fn(),
    postRun: vi.fn(),
    discardRun: vi.fn(),
  };
});

const api = vi.mocked(apiClient);

class MockNotification {
  public static permission: NotificationPermission = 'default';
  public static requestPermission = vi.fn(() => Promise.resolve<NotificationPermission>('granted'));
  public static instances: Array<MockNotification> = [];

  public readonly title: string;
  public readonly options: NotificationOptions | undefined;
  public onclick: (() => void) | null = null;
  public close = vi.fn();

  public constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    MockNotification.instances.push(this);
  }
}

function emit(event: ServerEvent): void {
  act(() => MockEventSource.latest().emit(event));
}

async function renderApp() {
  render(<App />);
  await screen.findByRole('heading', { name: 'Add the fleet health widget' });
  act(() => MockEventSource.latest().open());
}

describe('App', () => {
  beforeEach(() => {
    MockEventSource.reset();
    MockNotification.instances = [];
    MockNotification.permission = 'default';
    MockNotification.requestPermission.mockClear();
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('Notification', MockNotification);
    api.fetchQuests.mockResolvedValue({
      quests: [makeQuest()],
      fetchedAt: new Date().toISOString(),
      source: 'linear',
    });
    api.fetchRuns.mockRejectedValue(new ApiRequestError(501, 'notImplemented', 'Not implemented'));
    api.fetchPlayer.mockResolvedValue({ player: makePlayer() });
    api.fetchAchievements.mockResolvedValue({ achievements: makeAchievements() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test('loads the board and the player, and shows the live connection', async () => {
    await renderApp();
    expect(screen.getByRole('img', { name: 'Level 3' })).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(MockEventSource.latest().url).toBe('/api/events');
  });

  test('never asks for notification permission on load, only from the HUD toggle', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Enable notifications/ }));
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: /Notifications on/ })).toBeTruthy();
  });

  test('runs a review from send to loot: toast, browser notification and result', async () => {
    const user = userEvent.setup();
    MockNotification.permission = 'granted';
    const queued = makeRun({ status: 'queued', startedAt: new Date().toISOString() });
    api.startReview.mockResolvedValue({ run: queued });
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Send review agent' }));
    expect(api.startReview).toHaveBeenCalledWith('Trackunit/manager#101');
    expect(await screen.findByText('Agent is gearing up…')).toBeTruthy();

    emit({ type: 'runUpdated', run: { ...queued, status: 'running' } });
    expect(screen.getByText('Agent on quest')).toBeTruthy();

    emit({ type: 'runUpdated', run: { ...queued, status: 'finished', result: makeResult() } });
    const toasts = screen.getByRole('list', { name: 'Notifications' });
    expect(within(toasts).getByText('Loot ready!')).toBeTruthy();
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances.at(0)?.options?.body).toContain('Trackunit/manager#101');

    emit({ type: 'runUpdated', run: { ...queued, status: 'finished', result: makeResult() } });
    expect(MockNotification.instances).toHaveLength(1);

    await user.click(within(toasts).getByRole('button', { name: 'View loot' }));
    expect(screen.getByRole('dialog', { name: 'Loot from Trackunit/manager#101' })).toBeTruthy();
  });

  test('clicking the browser notification opens the result', async () => {
    MockNotification.permission = 'granted';
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    await renderApp();

    emit({ type: 'runUpdated', run: makeRun({ status: 'finished', result: makeResult() }) });
    act(() => MockNotification.instances.at(0)?.onclick?.());

    expect(focus).toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Loot from Trackunit/manager#101' })).toBeTruthy();
  });

  test('a failed run shows an error toast and a retry on the card', async () => {
    await renderApp();
    emit({
      type: 'runUpdated',
      run: makeRun({ status: 'error', error: { message: 'Agent crashed' } }),
    });
    expect(
      within(screen.getByRole('list', { name: 'Errors' })).getByText('Agent crashed'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  test('approving needs confirmation and clears the quest', async () => {
    const user = userEvent.setup();
    api.approveQuest.mockResolvedValue({
      questId: 'Trackunit/manager#101',
      approvedVia: 'linear',
      outcome: { xpGained: 40, player: makePlayer({ xpIntoLevel: 190 }), unlocked: [] },
    });
    await renderApp();

    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(api.approveQuest).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Approve this PR?' });

    await user.click(within(dialog).getByRole('button', { name: 'Approve Trackunit/manager#101' }));
    expect(api.approveQuest).toHaveBeenCalledWith('Trackunit/manager#101', undefined);
    expect(await screen.findByText('Inbox Zero!')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('190');
  });

  test('shows XP popups and achievement toasts from the event stream', async () => {
    await renderApp();
    emit({
      type: 'xpGained',
      amount: 75,
      reason: 'reviewPosted',
      player: makePlayer({ xpIntoLevel: 225 }),
    });
    expect(screen.getByText('+75 XP')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('225');

    const teamPlayer = makeAchievements().find((entry) => entry.id === 'team-player');
    if (!teamPlayer) {
      throw new Error('fixture missing');
    }
    emit({
      type: 'achievementUnlocked',
      achievement: teamPlayer,
      unlockedAt: new Date().toISOString(),
    });
    emit({
      type: 'achievementUnlocked',
      achievement: teamPlayer,
      unlockedAt: new Date().toISOString(),
    });
    expect(screen.getAllByText('Achievement unlocked: Team Player')).toHaveLength(1);
  });

  test('shows the quest error state and recovers on retry', async () => {
    const user = userEvent.setup();
    api.fetchQuests.mockRejectedValueOnce(
      new ApiRequestError(501, 'notImplemented', 'Not implemented'),
    );
    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The server does not support this yet.');

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Add the fleet health widget' }),
    ).toBeTruthy();
  });

  test('reconnects after the stream drops and resyncs the board', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderApp();
      expect(api.fetchQuests).toHaveBeenCalledTimes(1);
      act(() => MockEventSource.latest().fail());
      expect(screen.getByText('Reconnecting…')).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      act(() => MockEventSource.latest().open());
      expect(screen.getByText('Live')).toBeTruthy();
      expect(api.fetchQuests).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
