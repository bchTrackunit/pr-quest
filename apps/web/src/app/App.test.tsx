// @vitest-environment jsdom
/* oxlint-disable no-restricted-globals -- tests reset the jsdom storage the board persists to */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReviewRun, ServerEvent } from '@pr-quest/contract/api';
import { ApiRequestError } from '../platform/apiClient.ts';
import * as apiClient from '../platform/apiClient.ts';
import { App } from './App.tsx';
import {
  makeAchievements,
  makeMyPullRequest,
  makePlayer,
  makeQuest,
  makeResult,
  makeRun,
} from '../platform/test-utils/fixtures.ts';
import { MockEventSource } from './test-utils/MockEventSource.ts';

vi.mock('../platform/apiClient.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/apiClient.ts')>();
  return {
    ...actual,
    fetchQuests: vi.fn(),
    fetchMyPullRequests: vi.fn(),
    startSelfReview: vi.fn(),
    fetchRuns: vi.fn(),
    fetchPlayer: vi.fn(),
    fetchAchievements: vi.fn(),
    startReview: vi.fn(),
    approveQuest: vi.fn(),
    postRun: vi.fn(),
    saveFindingSelection: vi.fn(),
    discardRun: vi.fn(),
    fetchAuthStatus: vi.fn(),
    signOut: vi.fn(),
    fetchSettings: vi.fn(),
    fetchModels: vi.fn(),
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
      stale: false,
    });
    api.fetchMyPullRequests.mockResolvedValue({
      pullRequests: [],
      fetchedAt: new Date().toISOString(),
      stale: false,
    });
    api.fetchRuns.mockRejectedValue(new ApiRequestError(501, 'notImplemented', 'Not implemented'));
    api.fetchPlayer.mockResolvedValue({ player: makePlayer() });
    api.fetchAchievements.mockResolvedValue({ achievements: makeAchievements() });
    api.fetchAuthStatus.mockResolvedValue({
      clientIdConfigured: true,
      account: { login: 'octocat', tokenSource: 'gh' },
      device: { state: 'idle' },
    });
    api.fetchSettings.mockResolvedValue({
      reviewProvider: 'claude',
      models: {},
      keys: {
        cursor: { set: true, source: 'env', last4: 'c0de' },
        anthropic: { set: false },
        linear: { set: false },
      },
    });
    api.fetchModels.mockResolvedValue({ provider: 'claude', models: [], source: 'fallback' });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    localStorage.clear();
  });

  test('loads the board and the player, and shows the live connection', async () => {
    await renderApp();
    expect(screen.getByRole('img', { name: 'Level 3' })).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(MockEventSource.latest().url).toBe('/api/events');
    expect(await screen.findByRole('button', { name: 'GitHub account @octocat' })).toBeTruthy();
  });

  test('the header corner holds only Live and the account; its popout holds the rest', async () => {
    const user = userEvent.setup();
    await renderApp();
    const corner = screen.getByRole('group', { name: 'Status and account' });
    const hud = screen.getByRole('region', { name: 'Player' });

    const chip = await within(corner).findByRole('button', { name: 'GitHub account @octocat' });
    expect(within(corner).getAllByRole('button')).toEqual([chip]);
    expect(within(corner).getByRole('status').textContent).toContain('Live');
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
    expect(
      within(hud)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['🏅 Achievements 1/3']);

    await user.click(chip);
    const menu = screen.getByRole('dialog', { name: 'Account and settings' });
    expect(within(menu).getByText('gh CLI')).toBeTruthy();
    expect(within(menu).getByRole('switch', { name: 'Notifications' })).toBeTruthy();
    expect(within(menu).getByRole('switch', { name: 'Sound' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Settings' })).toHaveLength(1);

    await user.click(within(menu).getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(screen.queryByRole('dialog', { name: 'Account and settings' })).toBeNull();
    expect(document.activeElement).toBe(
      within(dialog).getByRole('heading', { name: 'GitHub account' }),
    );
    expect(within(dialog).getByText('Using the GitHub CLI login (gh fallback)')).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  test('never asks for notification permission on load, only from the popout switch', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('button', { name: 'GitHub account @octocat' }));
    const notifications = screen.getByRole('switch', { name: 'Notifications' });
    expect(notifications.getAttribute('aria-checked')).toBe('false');
    await user.click(notifications);
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(notifications.getAttribute('aria-checked')).toBe('true'));
  });

  test('the sound switch toggles sound and leaves the popout open', async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByRole('button', { name: 'GitHub account @octocat' }));
    const sound = screen.getByRole('switch', { name: 'Sound' });
    expect(sound.getAttribute('aria-checked')).toBe('true');
    await user.click(sound);
    expect(sound.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('dialog', { name: 'Account and settings' })).toBeTruthy();
  });

  test('disables the agent on quests the Cursor provider refuses, once the settings load', async () => {
    api.fetchSettings.mockResolvedValue({
      reviewProvider: 'cursor',
      models: {},
      keys: { cursor: { set: true }, anthropic: { set: false }, linear: { set: false } },
    });
    api.fetchQuests.mockResolvedValue({
      quests: [makeQuest({ authorAssociation: 'NONE', isCrossRepository: false })],
      fetchedAt: new Date().toISOString(),
      source: 'linear',
      stale: false,
    });
    await renderApp();

    const send = screen.getByRole('button', { name: 'Summon agent' });
    await vi.waitFor(() => expect(send).toHaveProperty('disabled', true));
    expect(screen.getByText(/Review it with Claude instead/)).toBeTruthy();
  });

  test('re-reads the review provider when the settings close', async () => {
    const user = userEvent.setup();
    api.fetchQuests.mockResolvedValue({
      quests: [makeQuest({ authorAssociation: 'NONE', isCrossRepository: false })],
      fetchedAt: new Date().toISOString(),
      source: 'linear',
      stale: false,
    });
    await renderApp();
    const send = screen.getByRole('button', { name: 'Summon agent' });
    expect(send).toHaveProperty('disabled', false);

    api.fetchSettings.mockResolvedValue({
      reviewProvider: 'cursor',
      models: {},
      keys: { cursor: { set: true }, anthropic: { set: false }, linear: { set: false } },
    });
    await user.click(await screen.findByRole('button', { name: 'GitHub account @octocat' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.keyboard('{Escape}');

    await vi.waitFor(() => expect(send).toHaveProperty('disabled', true));
  });

  test('runs a review from send to loot: toast, browser notification and result', async () => {
    const user = userEvent.setup();
    MockNotification.permission = 'granted';
    const queued = makeRun({ status: 'queued', startedAt: new Date().toISOString() });
    api.startReview.mockResolvedValue({ run: queued });
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Summon agent' }));
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

  test('a missingConfig review error opens the settings at the missing key', async () => {
    const user = userEvent.setup();
    api.startReview.mockRejectedValue(
      new ApiRequestError(
        400,
        'missingConfig',
        'Claude reviews need an Anthropic API key. Add it in Settings.',
        'claude',
      ),
    );
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Summon agent' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Claude reviews need an Anthropic API key');

    await user.click(within(error).getByRole('button', { name: /Open settings/ }));

    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const row = await within(dialog).findByRole('listitem', { name: 'Claude (Anthropic)' });
    expect(within(row).getByText(/Needed for Claude reviews/)).toBeTruthy();
    expect(document.activeElement).toBe(within(row).getByLabelText('Claude (Anthropic) key'));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement?.textContent).toContain('Open settings');
  });

  test('other review errors offer no settings shortcut', async () => {
    const user = userEvent.setup();
    api.startReview.mockRejectedValue(new ApiRequestError(409, 'conflict', 'Refresh the board'));
    await renderApp();

    await user.click(screen.getByRole('button', { name: 'Summon agent' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Refresh the board');
    expect(within(error).queryByRole('button')).toBeNull();
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

  describe('finding selection', () => {
    const finished = makeRun({ status: 'finished', result: makeResult() });
    const withSelection = (selectedFindings: Array<number>): ReviewRun => ({
      ...finished,
      selectedFindings,
    });

    async function openLoot() {
      const user = userEvent.setup();
      await renderApp();
      await user.click(await screen.findByRole('button', { name: /Loot ready/ }));
      return {
        user,
        dialog: screen.getByRole('dialog', { name: 'Loot from Trackunit/manager#101' }),
      };
    }

    const toggle = (dialog: HTMLElement, location: string) =>
      within(dialog).getByRole('button', { name: `Select ${location}` });

    test('is saved on the server and still there after a reload', async () => {
      api.fetchRuns.mockResolvedValue({ runs: [finished] });
      api.saveFindingSelection.mockResolvedValue({ run: withSelection([1]) });
      const { user, dialog } = await openLoot();

      await user.click(toggle(dialog, 'src/query.ts:40'));

      expect(api.saveFindingSelection).toHaveBeenCalledWith('run-1', {
        findingIndexes: [1],
        selected: true,
      });
      expect(toggle(dialog, 'src/query.ts:40').ariaPressed).toBe('true');

      cleanup();
      MockEventSource.reset();
      api.fetchRuns.mockResolvedValue({ runs: [withSelection([1])] });
      const reloaded = await openLoot();

      expect(toggle(reloaded.dialog, 'src/query.ts:40').ariaPressed).toBe('true');
      expect(within(reloaded.dialog).getByRole('status').textContent).toBe('1 of 3 selected');
    });

    test('follows selections made elsewhere, pushed over the event stream', async () => {
      api.fetchRuns.mockResolvedValue({ runs: [finished] });
      const { dialog } = await openLoot();

      emit({ type: 'runUpdated', run: withSelection([0, 1, 2]) });

      expect(within(dialog).getByRole('status').textContent).toBe('3 of 3 selected');
    });

    test('posting sends the selected findings once the selection is saved', async () => {
      api.fetchRuns.mockResolvedValue({ runs: [finished] });
      let save = (): void => undefined;
      api.saveFindingSelection.mockImplementation(
        () =>
          new Promise((resolve) => {
            save = () => resolve({ run: withSelection([0, 1, 2]) });
          }),
      );
      api.postRun.mockResolvedValue({
        run: { ...withSelection([0, 1, 2]), disposition: 'posted' },
        reviewUrl: 'https://github.com/Trackunit/manager/pull/101#pullrequestreview-1',
        outcome: { xpGained: 30, gains: [], player: makePlayer(), unlocked: [] },
      });
      const { user, dialog } = await openLoot();

      await user.click(within(dialog).getByRole('button', { name: 'Select all' }));
      await user.click(within(dialog).getByRole('button', { name: 'Post to PR' }));
      expect(within(dialog).getByRole('group', { name: /^Post to/ }).textContent).toContain(
        'Posting all 3 findings',
      );
      await user.click(within(dialog).getByRole('button', { name: 'Confirm post' }));

      expect(api.saveFindingSelection).toHaveBeenCalledWith('run-1', {
        findingIndexes: [0, 1, 2],
        selected: true,
      });
      expect(api.postRun).not.toHaveBeenCalled();
      save();
      await vi.waitFor(() =>
        expect(api.postRun).toHaveBeenCalledWith('run-1', {
          event: 'comment',
          findingIndexes: [0, 1, 2],
        }),
      );
    });
  });

  test('a failed run shows an error toast and a retry on the card', async () => {
    await renderApp();
    emit({
      type: 'runUpdated',
      run: makeRun({ status: 'error', error: { message: 'Agent crashed' } }),
    });
    const errors = screen.getByRole('list', { name: 'Errors' });
    expect(within(errors).getByText('Agent crashed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    const dismiss = within(errors).getByRole('button', { name: 'Dismiss notification' });
    const tooltip = document.getElementById(dismiss.getAttribute('aria-describedby') ?? '');
    expect(tooltip?.getAttribute('role')).toBe('tooltip');
    expect(tooltip?.textContent).toBe('Dismiss');
  });

  test('approving needs confirmation and clears the quest', async () => {
    const user = userEvent.setup();
    const player = makePlayer({ xpIntoLevel: 190 });
    const gain = { eventId: 'xp-1', amount: 40, reason: 'approved' as const };
    api.approveQuest.mockResolvedValue({
      questId: 'Trackunit/manager#101',
      approvedVia: 'linear',
      outcome: { xpGained: 40, gains: [gain], player, unlocked: [] },
    });
    await renderApp();

    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    expect(api.approveQuest).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Approve this PR?' });

    await user.click(within(dialog).getByRole('button', { name: 'Approve Trackunit/manager#101' }));
    expect(api.approveQuest).toHaveBeenCalledWith(
      'Trackunit/manager#101',
      '0123456789abcdef0123456789abcdef01234567',
      undefined,
    );
    expect(await screen.findByText('Inbox Zero!')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('190');
    expect(screen.getAllByText('+40 XP')).toHaveLength(1);

    emit({ type: 'xpGained', ...gain, player });
    expect(screen.getAllByText('+40 XP')).toHaveLength(1);
  });

  test('a headChanged approval reloads the quest and shows its new commit', async () => {
    const user = userEvent.setup();
    const newHead = 'fedcba9876543210fedcba9876543210fedcba98';
    api.approveQuest.mockRejectedValue(
      new ApiRequestError(409, 'headChanged', 'New commits were pushed'),
    );
    await renderApp();
    api.fetchQuests.mockResolvedValue({
      quests: [makeQuest({ headSha: newHead })],
      fetchedAt: new Date().toISOString(),
      source: 'linear',
      stale: false,
    });

    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this PR?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve Trackunit/manager#101' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('Re-check');
    expect(await within(dialog).findByText('fedcba9')).toBeTruthy();
    expect(api.fetchQuests).toHaveBeenCalledTimes(2);
    expect(api.fetchQuests).toHaveBeenLastCalledWith(undefined, {});
  });

  test('Refresh bypasses the server cache', async () => {
    const user = userEvent.setup();
    await renderApp();
    expect(api.fetchQuests).toHaveBeenLastCalledWith(expect.any(AbortSignal), {});

    await user.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(api.fetchQuests).toHaveBeenLastCalledWith(undefined, { refresh: true });
  });

  test('shows XP popups and achievement toasts from the event stream', async () => {
    await renderApp();
    emit({
      type: 'xpGained',
      eventId: 'xp-7',
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
    expect(screen.getByText('Rare · +50 bonus XP')).toBeTruthy();
  });

  test('a hidden achievement unlocked by an approval is announced by its real name', async () => {
    const user = userEvent.setup();
    const speedrunner = {
      id: 'speedrunner' as const,
      name: 'Speedrunner',
      description: 'Approve a PR within 5 minutes of being asked to review it.',
      icon: '⏱️',
      xpReward: 100,
      rarity: 'epic' as const,
      category: 'secret' as const,
      secret: true,
    };
    api.fetchAchievements.mockResolvedValue({
      achievements: [{ ...speedrunner, name: '???', icon: '❔', description: 'A very fast hand.' }],
    });
    api.approveQuest.mockResolvedValue({
      questId: 'Trackunit/manager#101',
      approvedVia: 'linear',
      outcome: {
        xpGained: 140,
        gains: [
          { eventId: 'xp-1', amount: 40, reason: 'approved' },
          {
            eventId: 'xp-achievement-speedrunner',
            amount: 100,
            reason: 'achievement',
            achievementId: 'speedrunner',
          },
        ],
        player: makePlayer(),
        unlocked: [{ id: 'speedrunner', unlockedAt: new Date().toISOString() }],
        achievements: [speedrunner],
      },
    });
    await renderApp();

    await user.click(screen.getByRole('button', { name: /^Approve/ }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this PR?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve Trackunit/manager#101' }));

    expect(await screen.findByText('Achievement unlocked: Speedrunner')).toBeTruthy();
    expect(screen.getByText('Epic · +100 bonus XP')).toBeTruthy();
    expect(screen.queryByText('Achievement unlocked: ???')).toBeNull();
  });

  test("signing out clears the previous player's runs, errors, toasts and player", async () => {
    const user = userEvent.setup();
    api.fetchAuthStatus.mockResolvedValue({
      clientIdConfigured: true,
      account: { login: 'octocat', tokenSource: 'oauth' },
      device: { state: 'idle' },
    });
    api.fetchRuns.mockResolvedValue({ runs: [makeRun({ status: 'running' })] });
    api.startReview.mockRejectedValue(new ApiRequestError(409, 'conflict', 'Already running'));
    await renderApp();
    expect(await screen.findByText('Agent on quest')).toBeTruthy();
    emit({
      type: 'runUpdated',
      run: makeRun({ id: 'run-old', status: 'error', error: { message: 'Agent crashed' } }),
    });
    expect(
      within(screen.getByRole('list', { name: 'Errors' })).getByText('Agent crashed'),
    ).toBeTruthy();

    const notSignedIn = new ApiRequestError(401, 'notSignedIn', 'Sign in with GitHub first.');
    api.signOut.mockResolvedValue({ clientIdConfigured: true, device: { state: 'idle' } });
    api.fetchQuests.mockRejectedValue(notSignedIn);
    api.fetchRuns.mockRejectedValue(notSignedIn);
    api.fetchPlayer.mockRejectedValue(notSignedIn);
    api.fetchAchievements.mockRejectedValue(notSignedIn);
    const streamsBefore = MockEventSource.instances.length;

    await user.click(await screen.findByRole('button', { name: 'GitHub account @octocat' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: /Sign in with GitHub/ })).toBeTruthy();
    expect(await screen.findAllByText(/Sign in with GitHub first/)).not.toHaveLength(0);
    expect(screen.queryByText('Agent on quest')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Add the fleet health widget' })).toBeNull();
    expect(screen.queryByText('Agent crashed')).toBeNull();
    expect(screen.queryByRole('img', { name: 'Level 3' })).toBeNull();
    expect(MockEventSource.instances).toHaveLength(streamsBefore + 1);
    expect(MockEventSource.instances.at(streamsBefore - 1)?.isClosed).toBe(true);
  });

  test("a late response for the previous account doesn't come back after the switch", async () => {
    const user = userEvent.setup();
    api.fetchAuthStatus.mockResolvedValue({
      clientIdConfigured: true,
      account: { login: 'octocat', tokenSource: 'oauth' },
      device: { state: 'idle' },
    });
    let resolveRuns: (value: { runs: Array<ReturnType<typeof makeRun>> }) => void = () => undefined;
    api.fetchRuns.mockReturnValue(
      new Promise((resolver) => {
        resolveRuns = resolver;
      }),
    );
    await renderApp();

    api.signOut.mockResolvedValue({ clientIdConfigured: true, device: { state: 'idle' } });
    api.fetchRuns.mockResolvedValue({ runs: [] });
    await user.click(await screen.findByRole('button', { name: 'GitHub account @octocat' }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('button', { name: /Sign in with GitHub/ });

    act(() => resolveRuns({ runs: [makeRun({ status: 'running' })] }));
    await act(() => Promise.resolve());
    expect(screen.queryByText('Agent on quest')).toBeNull();
  });

  test('says so when the runs fail to load', async () => {
    api.fetchRuns.mockRejectedValue(new ApiRequestError(500, 'internal', 'Disk full'));
    await renderApp();

    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't load your review runs: Disk full",
    );
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
      expect(api.fetchQuests).toHaveBeenLastCalledWith(undefined, {});
      expect(api.fetchMyPullRequests).toHaveBeenCalledTimes(2);
      expect(api.fetchMyPullRequests).toHaveBeenLastCalledWith(undefined, {});
    } finally {
      vi.useRealTimers();
    }
  });

  test('never forces a GitHub refresh on page load or stream reconnects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderApp();
      for (let drop = 0; drop < 3; drop += 1) {
        act(() => MockEventSource.latest().fail());
        act(() => {
          vi.advanceTimersByTime(30_000);
        });
        act(() => MockEventSource.latest().open());
      }

      expect(api.fetchQuests).toHaveBeenCalledTimes(4);
      for (const [, options] of [
        ...api.fetchQuests.mock.calls,
        ...api.fetchMyPullRequests.mock.calls,
      ]) {
        expect(options?.refresh).not.toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps the last quests during a rate limit and holds Refresh until it ends', async () => {
    const user = userEvent.setup();
    await renderApp();

    emit({
      type: 'questsUpdated',
      quests: [makeQuest()],
      fetchedAt: new Date(Date.now() - 120_000).toISOString(),
      source: 'github',
      stale: true,
      rateLimit: { kind: 'primary', limitedUntil: new Date(Date.now() + 90_000).toISOString() },
    });

    expect(screen.getByText(/GitHub rate limit reached, showing results from/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Add the fleet health widget' })).toBeTruthy();
    const refresh = screen.getByRole('button', { name: /Retry in/ });
    expect(refresh).toHaveProperty('disabled', true);

    await user.click(refresh);
    expect(api.fetchQuests).toHaveBeenCalledTimes(1);
  });

  describe('My PRs', () => {
    const needsFixes = makeMyPullRequest({
      number: 7,
      title: 'Fix the map legend',
      reviewState: 'changesRequested',
      needsMyAction: true,
    });
    const waiting = makeMyPullRequest({ number: 8, title: 'Speed up the export' });

    beforeEach(() => {
      api.fetchMyPullRequests.mockResolvedValue({
        pullRequests: [needsFixes, waiting],
        fetchedAt: new Date().toISOString(),
        stale: false,
      });
    });

    test('a tab next to the review board shows my PRs and how many need my action', async () => {
      const user = userEvent.setup();
      await renderApp();

      const tab = await screen.findByRole('tab', { name: 'My PRs (1), need my action' });
      const boardTab = screen.getByRole('tab', { name: 'Review board' });
      expect(boardTab.getAttribute('aria-selected')).toBe('true');

      await user.click(tab);
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(screen.getByRole('tabpanel', { name: /My PRs/ })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Fix the map legend' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Add the fleet health widget' })).toBeNull();

      await user.keyboard('{ArrowLeft}');
      expect(document.activeElement).toBe(boardTab);
      expect(screen.getByRole('heading', { name: 'Add the fleet health widget' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Fix the map legend' })).toBeNull();
    });

    test('the count follows the list pushed over the event stream', async () => {
      await renderApp();
      await screen.findByRole('tab', { name: 'My PRs (1), need my action' });

      emit({
        type: 'myPullRequestsUpdated',
        pullRequests: [needsFixes, { ...waiting, unresolvedThreads: 2, needsMyAction: true }],
        fetchedAt: new Date().toISOString(),
        stale: false,
      });
      expect(screen.getByRole('tab', { name: 'My PRs (2), need my action' })).toBeTruthy();
    });

    test('Refresh on the tab forces a GitHub refetch of my PRs', async () => {
      const user = userEvent.setup();
      await renderApp();
      await user.click(await screen.findByRole('tab', { name: /My PRs/ }));
      expect(api.fetchMyPullRequests).toHaveBeenLastCalledWith(expect.any(AbortSignal), {});

      await user.click(screen.getByRole('button', { name: /Refresh/ }));
      expect(api.fetchMyPullRequests).toHaveBeenLastCalledWith(undefined, { refresh: true });
      expect(api.fetchQuests).toHaveBeenCalledTimes(1);
    });

    test('a self-review is read-only, and after Discard the agent can be summoned again', async () => {
      const user = userEvent.setup();
      const queued = makeRun({
        id: 'self-1',
        questId: needsFixes.id,
        ownPr: true,
        status: 'queued',
        startedAt: new Date().toISOString(),
        quest: {
          title: needsFixes.title,
          repo: needsFixes.repo,
          number: needsFixes.number,
          githubUrl: needsFixes.githubUrl,
        },
      });
      const finished: ReviewRun = { ...queued, status: 'finished', result: makeResult() };
      api.startSelfReview.mockResolvedValue({ run: queued });
      api.discardRun.mockResolvedValue({ run: { ...finished, disposition: 'discarded' } });
      await renderApp();
      await user.click(await screen.findByRole('tab', { name: /My PRs/ }));

      const legend = within(screen.getByRole('article', { name: 'Fix the map legend' }));
      await user.click(legend.getByRole('button', { name: 'Summon agent' }));
      expect(api.startSelfReview).toHaveBeenCalledWith('Trackunit/manager#7');
      expect(api.startReview).not.toHaveBeenCalled();
      expect(await legend.findByText('Agent is gearing up…')).toBeTruthy();

      emit({ type: 'runUpdated', run: finished });
      await user.click(legend.getByRole('button', { name: /Loot ready/ }));
      const dialog = screen.getByRole('dialog', { name: 'Self-review of Trackunit/manager#7' });
      expect(within(dialog).queryByRole('button', { name: 'Post to PR' })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Approve' })).toBeNull();

      await user.click(within(dialog).getByRole('button', { name: 'Discard' }));
      expect(api.discardRun).toHaveBeenCalledWith('self-1');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(legend.getByRole('button', { name: 'Summon agent' })).toBeTruthy();
    });

    test('author XP pops and leaves a notice naming the PR', async () => {
      await renderApp();
      await screen.findByRole('tab', { name: /My PRs/ });

      emit({
        type: 'xpGained',
        eventId: 'xp-merge-7',
        amount: 40,
        reason: 'prMerged',
        questId: needsFixes.id,
        player: makePlayer(),
      });
      emit({
        type: 'xpGained',
        eventId: 'xp-merge-7',
        amount: 40,
        reason: 'prMerged',
        questId: needsFixes.id,
        player: makePlayer(),
      });
      emit({
        type: 'xpGained',
        eventId: 'xp-thread-9',
        amount: 6,
        reason: 'threadResolved',
        questId: 'Trackunit/manager#999',
        player: makePlayer(),
      });

      expect(screen.getByText('+40 XP')).toBeTruthy();
      const toasts = screen.getByRole('list', { name: 'Notifications' });
      expect(within(toasts).getAllByText('Your PR merged: +40 XP')).toHaveLength(1);
      expect(
        within(toasts).getByText('Trackunit/manager#7: Fix the map legend', { exact: false }),
      ).toBeTruthy();
      expect(within(toasts).getByText('Thread resolved: +6 XP')).toBeTruthy();
      expect(within(toasts).getByText('Trackunit/manager#999')).toBeTruthy();
    });

    test('an achievement replayed on connect is announced even though the list already has it', async () => {
      await renderApp();
      const firstBlood = makeAchievements().find((entry) => entry.id === 'first-blood');
      if (!firstBlood) {
        throw new Error('fixture missing');
      }

      emit({
        type: 'achievementUnlocked',
        achievement: firstBlood,
        unlockedAt: '2026-10-20T10:00:00.000Z',
      });

      const toasts = screen.getByRole('list', { name: 'Notifications' });
      expect(within(toasts).getByText('Achievement unlocked: First Blood')).toBeTruthy();
    });

    test('review XP gets no author notice', async () => {
      await renderApp();
      emit({
        type: 'xpGained',
        eventId: 'xp-review-1',
        amount: 75,
        reason: 'reviewPosted',
        player: makePlayer(),
      });
      const toasts = screen.getByRole('list', { name: 'Notifications' });
      expect(within(toasts).queryAllByRole('listitem')).toHaveLength(0);
    });
  });
});
