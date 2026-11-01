// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HeaderControls, type HeaderControlsProps } from './HeaderControls.tsx';

function renderControls(overrides: Partial<HeaderControlsProps> = {}) {
  const props: HeaderControlsProps = {
    connection: 'open',
    notificationAccess: 'default',
    notificationsEnabled: false,
    soundEnabled: true,
    onClickNotifications: vi.fn(),
    onClickSound: vi.fn(),
    onClickSettings: vi.fn(),
    ...overrides,
  };
  render(<HeaderControls {...props} />);
  return props;
}

describe('HeaderControls', () => {
  afterEach(cleanup);

  test('groups live status, the toggles, settings and the account, with the account last', () => {
    renderControls({ account: <button type="button">@octocat</button> });
    const group = screen.getByRole('group', { name: 'Account and settings' });

    expect(within(group).getByRole('status').textContent).toContain('Live');
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['🔕', '🔊', '⚙️', '@octocat']);
  });

  test('the gear opens the settings and the sound toggle reports its state', async () => {
    const user = userEvent.setup();
    const props = renderControls({ soundEnabled: false });

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(props.onClickSettings).toHaveBeenCalledTimes(1);

    const sound = screen.getByRole('button', { name: 'Sound' });
    expect(sound.getAttribute('aria-pressed')).toBe('false');
    await user.click(sound);
    expect(props.onClickSound).toHaveBeenCalledTimes(1);
  });

  test('asks for notifications from a button, and disables it when blocked', async () => {
    const user = userEvent.setup();
    const props = renderControls();
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(props.onClickNotifications).toHaveBeenCalled();
    cleanup();

    renderControls({ notificationAccess: 'denied' });
    expect(
      screen.getByRole('button', { name: 'Notifications blocked' }).hasAttribute('disabled'),
    ).toBe(true);
    cleanup();

    renderControls({ notificationAccess: 'granted', notificationsEnabled: true });
    expect(
      screen.getByRole('button', { name: 'Notifications on' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
