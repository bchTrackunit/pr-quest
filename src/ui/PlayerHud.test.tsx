// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PlayerHud, type PlayerHudProps } from './PlayerHud.tsx';
import { makeAchievements, makePlayer } from './test-utils/fixtures.ts';

function renderHud(overrides: Partial<PlayerHudProps> = {}) {
  const props: PlayerHudProps = {
    player: makePlayer(),
    achievements: makeAchievements(),
    connection: 'open',
    notificationAccess: 'default',
    notificationsEnabled: false,
    soundEnabled: true,
    onClickNotifications: vi.fn(),
    onClickSound: vi.fn(),
    ...overrides,
  };
  render(<PlayerHud {...props} />);
  return props;
}

describe('PlayerHud', () => {
  afterEach(cleanup);

  test('shows level, XP progress, streak and recent achievements', () => {
    renderHud();
    expect(screen.getByRole('img', { name: 'Level 3' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Experience toward level 4' });
    expect(bar.getAttribute('aria-valuenow')).toBe('150');
    expect(bar.getAttribute('aria-valuemax')).toBe('400');
    expect(screen.getByText(/2-day streak/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Recent achievements' })).getByText('First Blood'),
    ).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Live');
  });

  test('handles a missing player gracefully', () => {
    renderHud({ player: undefined, playerError: 'The server does not support this yet.' });
    expect(screen.getByRole('img', { name: 'Level unknown' })).toBeTruthy();
    expect(screen.getByText(/Player stats unavailable/)).toBeTruthy();
  });

  test('opens the achievements panel with locked, secret and unlocked entries', async () => {
    const user = userEvent.setup();
    renderHud();
    await user.click(screen.getByRole('button', { name: /Achievements/ }));

    const dialog = screen.getByRole('dialog', { name: 'Achievements 1/3' });
    expect(within(dialog).getByText('First Blood')).toBeTruthy();
    expect(within(dialog).getByText('(unlocked)')).toBeTruthy();
    const progress = within(dialog).getByRole('progressbar', { name: 'Team Player progress' });
    expect(progress.getAttribute('value')).toBe('3');
    expect(within(dialog).getByText('???')).toBeTruthy();
    expect(within(dialog).queryByText('On Fire')).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('shows the account slot and a settings gear only when it can open settings', async () => {
    const user = userEvent.setup();
    const onClickSettings = vi.fn();
    renderHud({ account: <span>@octocat</span>, onClickSettings });
    expect(screen.getByText('@octocat')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onClickSettings).toHaveBeenCalledTimes(1);
    cleanup();

    renderHud();
    expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  test('asks for notifications from a button, and disables it when blocked', async () => {
    const user = userEvent.setup();
    const props = renderHud();
    await user.click(screen.getByRole('button', { name: /Enable notifications/ }));
    expect(props.onClickNotifications).toHaveBeenCalled();
    cleanup();

    renderHud({ notificationAccess: 'denied' });
    expect(
      screen.getByRole('button', { name: /Notifications blocked/ }).hasAttribute('disabled'),
    ).toBe(true);
    cleanup();

    renderHud({ notificationAccess: 'granted', notificationsEnabled: true });
    expect(
      screen.getByRole('button', { name: /Notifications on/ }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
